import {
  AI_PROMPT_VERSION,
  buildSystemPrompt,
  promptFingerprint,
} from './ai-prompt.constants';

// Acceptance 20. The system prompt and the report_review schema are part of
// every cached AI result's identity. Changing either without bumping
// AI_PROMPT_VERSION would serve old cached answers as if they came from the
// new prompt — so this pins the hash per version. When you change the
// prompt: bump AI_PROMPT_VERSION and add its hash here.
const FINGERPRINT_BY_VERSION: Record<string, string> = {
  'ai-2026.09.2':
    'ec21f13606b1425f26da43e8137b38839c9e164192bf562ddf27487e183d6060',
  'ai-2026.09.3':
    'd050adf8a6dca4f9bd8e85314c06d7abe04e348ce2d90208e5654ecca3318327',
  'ai-2026.09.4':
    '05b7cfb140b5af975a4ca502f5112ea2ce7f38349df2ee34c95091a13fbad069',
  'ai-2026.10.1':
    'fa3aff2fef9d58880d8f38e2116c4e3bbb3d568f903f921ad63535ebc65cc1db',
};

describe('AI prompt', () => {
  it('matches the pinned fingerprint for its version', () => {
    expect(promptFingerprint()).toBe(FINGERPRINT_BY_VERSION[AI_PROMPT_VERSION]);
  });

  // Acceptance 15: message/summary in the org locale, titles in English.
  it('asks for the org language and English titles', () => {
    const prompt = buildSystemPrompt('id');
    expect(prompt).toContain('Indonesian (Bahasa Indonesia)');
    expect(prompt).toContain('every "title" in short English');
    expect(buildSystemPrompt('en')).toContain('in English');
  });

  // The model used to report "files omitted" on PRs where nothing was.
  it('mentions omitted files only when the input lists them', () => {
    const prompt = buildSystemPrompt('en');
    expect(prompt).not.toContain('Mention any files omitted for size');
    expect(prompt).toContain('never claim a file was omitted otherwise');
  });

  // Severity calibration: UX feedback rated MAJOR raised safe PRs to
  // RISK · MEDIUM.
  it('caps UX feedback at minor and defines severity only once', () => {
    const prompt = buildSystemPrompt('en');
    expect(prompt).toContain('is never higher than "minor"');
    expect(prompt).toContain('One root cause = one finding.');
    expect(prompt).toContain('never start a title with "Potential"');
    expect(prompt.match(/"critical" = /g)).toHaveLength(1);
    expect(prompt).not.toContain('"major" = a likely bug');
  });

  it('treats repository content as data, not instructions', () => {
    expect(buildSystemPrompt('en')).toMatch(/never instructions/i);
  });
});
