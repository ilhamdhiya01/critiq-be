import { FindingCategory } from '../../../generated/prisma/enums';
import { parsePatch } from '../../../queue/diff/diff-parser';
import {
  isIgnoredPath,
  isMustScanPath,
} from '../../../queue/rules/path-filter';
import { AiRequest } from '../ai-provider.interface';
import {
  buildSystemPrompt,
  REPORT_REVIEW_SCHEMA,
  REPORT_REVIEW_TOOL,
  ReviewMode,
} from './ai-prompt.constants';

// Builds the one report_review request for a scan. Pure: no DB, no
// provider — the processor gathers the inputs, this decides what the model
// sees, and returns what the validator needs to check the answer against.

export const CHARS_PER_TOKEN = 3.5;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_ALREADY_REPORTED = 50;
const MAX_LIFECYCLE_ITEMS = 30;
export const REDACTED = '[REDACTED:secret]';

const RISKY_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'java',
  'php',
  'rb',
  'sql',
  'yaml',
  'yml',
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  php: 'PHP',
  rb: 'Ruby',
  rs: 'Rust',
  cs: 'C#',
  sql: 'SQL',
};

export interface PromptFileInput {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  patch: string | null;
  // The file at the head sha, split into lines — for context around hunks.
  // Null when unavailable (fetch failed, binary, too large): hunks only.
  headLines: string[] | null;
}

export interface StaticFindingInput {
  ruleId: string;
  category: FindingCategory | null;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  title: string;
  suppressed: boolean;
}

export interface PromptBuildInput {
  repoPath: string;
  pullTitle: string;
  pullDescription: string | null;
  sourceBranch: string;
  targetBranch: string;
  files: PromptFileInput[];
  staticFindings: StaticFindingInput[];
  locale: string;
  contextLines: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  // One extra system instruction, for the retry after an invalid answer.
  systemSuffix?: string;
  // v1.5.1 langkah 3: INCREMENTAL scans review only the latest push, with
  // what the previous review reported and what this push resolved.
  mode?: ReviewMode;
  lifecycle?: {
    resolved: LifecycleItem[];
    persisted: LifecycleItem[];
  };
}

export interface LifecycleItem {
  category: FindingCategory | null;
  filePath: string;
  lineStart: number;
  title: string;
}

export interface SentFile {
  // New-side numbers of the "+" lines the model saw for this file.
  addedLines: Set<number>;
}

export interface PromptBuildResult {
  request: AiRequest;
  sentFiles: Map<string, SentFile>;
  // Not sent: over the token budget, or config/infra files that never
  // leave Critiq.
  filesOmitted: string[];
  estimatedTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (base.toLowerCase().startsWith('dockerfile')) {
    return 'dockerfile';
  }
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
}

function secretLinesByFile(
  findings: StaticFindingInput[],
): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  for (const finding of findings) {
    if (!finding.ruleId.startsWith('secret.')) {
      continue;
    }
    const lines = byFile.get(finding.filePath) ?? new Set<number>();
    for (let line = finding.lineStart; line <= finding.lineEnd; line += 1) {
      lines.add(line);
    }
    byFile.set(finding.filePath, lines);
  }
  return byFile;
}

const pad = (n: number) => String(n).padStart(5, ' ');

interface RenderedFile {
  path: string;
  text: string;
  addedLines: Set<number>;
}

// One file, every line prefixed with its new-side number. With the head
// file available, each hunk is widened by `contextLines` and overlapping
// windows merge; without it, the hunks are printed as they came.
// Lines a static secret rule flagged are redacted — the value never leaves
// Critiq. Deleted lines are shown for understanding, unnumbered.
export function renderFile(
  file: PromptFileInput,
  secretLines: Set<number>,
  contextLines: number,
): RenderedFile | null {
  const hunks = parsePatch(file.patch ?? '');
  if (hunks.length === 0) {
    return null;
  }

  const added = new Set<number>();
  const patchText = new Map<number, string>();
  const deletedBefore = new Map<number, string[]>();
  let trailingDeleted: string[] = [];
  const ranges: [number, number][] = [];

  for (const hunk of hunks) {
    let min = Infinity;
    let max = -Infinity;
    let pendingDeleted: string[] = [];
    for (const line of hunk.lines) {
      if (line.type === 'del') {
        pendingDeleted.push(line.text);
        continue;
      }
      if (line.newLine === null) {
        continue;
      }
      if (pendingDeleted.length > 0) {
        deletedBefore.set(line.newLine, pendingDeleted);
        pendingDeleted = [];
      }
      patchText.set(line.newLine, line.text);
      if (line.type === 'add') {
        added.add(line.newLine);
      }
      min = Math.min(min, line.newLine);
      max = Math.max(max, line.newLine);
    }
    if (pendingDeleted.length > 0) {
      trailingDeleted = trailingDeleted.concat(pendingDeleted);
    }
    if (min !== Infinity) {
      ranges.push([min, max]);
    }
  }

  const head = file.headLines;
  const lastLine = head ? head.length : Infinity;
  const widened = ranges
    .map(([start, end]): [number, number] =>
      head
        ? [
            Math.max(1, start - contextLines),
            Math.min(lastLine, end + contextLines),
          ]
        : [start, end],
    )
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of widened) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  const out: string[] = [`### ${file.path} (${file.status})`];
  merged.forEach(([start, end], index) => {
    if (index > 0) {
      out.push('  ...');
    }
    for (let n = start; n <= end; n += 1) {
      for (const deleted of deletedBefore.get(n) ?? []) {
        out.push(`-       | ${deleted}`);
      }
      const known = patchText.get(n) ?? (head ? head[n - 1] : undefined);
      if (known === undefined) {
        continue; // outside both the hunk and the head file
      }
      const text = secretLines.has(n) ? REDACTED : known;
      out.push(`${added.has(n) ? '+' : ' '} ${pad(n)} | ${text}`);
    }
  });
  for (const deleted of trailingDeleted) {
    out.push(`-       | ${deleted}`);
  }
  return { path: file.path, text: out.join('\n'), addedLines: added };
}

function dominantLanguage(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const language = LANGUAGE_BY_EXTENSION[extensionOf(path)];
    if (language) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  let best = 'unknown';
  let bestCount = 0;
  for (const [language, count] of counts) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}

export function buildReviewPrompt(input: PromptBuildInput): PromptBuildResult {
  const secretLines = secretLinesByFile(input.staticFindings);
  const withFindings = new Set(
    input.staticFindings.filter((f) => !f.suppressed).map((f) => f.filePath),
  );

  const notSent: string[] = [];
  const candidates = input.files.filter((file) => {
    if (file.patch === null || isIgnoredPath(file.path)) {
      return false;
    }
    if (isMustScanPath(file.path)) {
      notSent.push(file.path);
      return false;
    }
    return true;
  });

  // Files with static findings first, then risky extensions, then smallest.
  const rank = (file: PromptFileInput) =>
    withFindings.has(file.path)
      ? 0
      : RISKY_EXTENSIONS.has(extensionOf(file.path)) ||
          extensionOf(file.path) === 'dockerfile'
        ? 1
        : 2;
  const ordered = [...candidates].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.patch?.length ?? 0) - (b.patch?.length ?? 0),
  );

  const rendered = ordered
    .map((file) =>
      renderFile(
        file,
        secretLines.get(file.path) ?? new Set(),
        input.contextLines,
      ),
    )
    .filter((file): file is RenderedFile => file !== null);

  const description = (input.pullDescription ?? '').trim();
  const alreadyReported = input.staticFindings
    .filter((f) => !f.suppressed)
    .slice(0, MAX_ALREADY_REPORTED)
    .map(
      (f) =>
        `- [${(f.category ?? 'OTHER').toLowerCase()}] ${f.filePath}:${f.lineStart}-${f.lineEnd} ${f.title}`,
    );

  const item = (f: LifecycleItem) =>
    `- [${(f.category ?? 'OTHER').toLowerCase()}] ${f.filePath}:${f.lineStart} ${f.title}`;
  const lifecycleBlocks =
    input.mode === 'incremental' && input.lifecycle
      ? [
          '',
          'RESOLVED IN THIS PUSH (previously reported; the lines changed. Re-report ONLY if the new code still has the same problem):',
          ...(input.lifecycle.resolved.length > 0
            ? input.lifecycle.resolved.slice(0, MAX_LIFECYCLE_ITEMS).map(item)
            : ['- none']),
          'PERSISTED FROM PREVIOUS PUSH (unchanged lines, already listed, do not repeat):',
          ...(input.lifecycle.persisted.length > 0
            ? input.lifecycle.persisted.slice(0, MAX_LIFECYCLE_ITEMS).map(item)
            : ['- none']),
        ]
      : [];

  const header = [
    `REPOSITORY: ${input.repoPath}`,
    `PULL REQUEST TITLE: ${input.pullTitle}`,
    'PULL REQUEST DESCRIPTION:',
    description ? description.slice(0, MAX_DESCRIPTION_CHARS) : '(none)',
    `BRANCHES: ${input.sourceBranch} -> ${input.targetBranch}`,
    `FILES CHANGED: ${input.files.length}`,
    `DOMINANT LANGUAGE: ${dominantLanguage(input.files.map((f) => f.path))}`,
    '',
    'ALREADY REPORTED BY STATIC RULES — do not repeat:',
    ...(alreadyReported.length > 0 ? alreadyReported : ['- none']),
    ...lifecycleBlocks,
  ].join('\n');

  const system =
    buildSystemPrompt(input.locale, input.mode ?? 'full') +
    (input.systemSuffix ?? '');
  const diffIntro =
    'DIFF (new-side line numbers; "+" marks added lines — the only lines a finding may point at):';

  // Drop files from the end until the prompt fits the input budget.
  const kept = [...rendered];
  const omittedForSize: string[] = [];
  const size = () =>
    estimateTokens(
      system + header + diffIntro + kept.map((f) => f.text).join('\n\n'),
    );
  while (kept.length > 0 && size() > input.maxInputTokens) {
    omittedForSize.unshift(kept.pop()!.path);
  }

  const notices: string[] = [];
  if (omittedForSize.length > 0) {
    notices.push(
      `OMITTED FOR SIZE: ${omittedForSize.join(', ')}`,
      'Mention in the summary that these files were not reviewed.',
    );
  }
  if (notSent.length > 0) {
    notices.push(
      `NOT SENT (configuration files kept private): ${notSent.join(', ')}`,
    );
  }

  const user = [
    header,
    '',
    ...(notices.length > 0 ? [...notices, ''] : []),
    diffIntro,
    '',
    kept.map((f) => f.text).join('\n\n'),
  ].join('\n');

  const sentFiles = new Map<string, SentFile>(
    kept.map((f) => [f.path, { addedLines: f.addedLines }]),
  );

  return {
    request: {
      system,
      user,
      tool: {
        name: REPORT_REVIEW_TOOL,
        description:
          'Report the review of this pull request: a short summary, an overall risk level, and each problem found.',
        schema: REPORT_REVIEW_SCHEMA,
      },
      maxTokens: input.maxOutputTokens,
      temperature: 0,
      timeoutMs: input.timeoutMs,
    },
    sentFiles,
    filesOmitted: [...omittedForSize, ...notSent],
    estimatedTokens: estimateTokens(system + user),
  };
}
