import { DiffMode, FullReason, ReviewPolicy } from '../generated/prisma/enums';
import { AI_PROMPT_VERSION } from '../modules/ai/scan/ai-prompt.constants';
import { RULESET_VERSION } from './rules/rules.constants';
import { decideScanMode } from './scan-queue.service';

// ESM-only packages reachable through scan-queue.service.
jest.mock('@nestjs/bullmq', () => ({ InjectQueue: () => () => undefined }));
jest.mock('bullmq', () => ({ Queue: class {} }));
jest.mock('../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

const base = {
  id: 'scan_1',
  headSha: 'aaa111',
  rulesetVersion: RULESET_VERSION,
  aiPromptVersion: AI_PROMPT_VERSION,
};

describe('decideScanMode', () => {
  it('scans a PR in full the first time', () => {
    expect(
      decideScanMode({
        base: null,
        full: false,
        effectivePolicy: ReviewPolicy.ALLOW_AI,
      }),
    ).toEqual({
      diffMode: DiffMode.FULL,
      fullReason: FullReason.FIRST_SCAN,
      baseScanId: null,
      prevHeadSha: null,
    });
  });

  it('is incremental from the last finished scan otherwise', () => {
    expect(
      decideScanMode({
        base,
        full: false,
        effectivePolicy: ReviewPolicy.ALLOW_AI,
      }),
    ).toEqual({
      diffMode: DiffMode.INCREMENTAL,
      fullReason: null,
      baseScanId: 'scan_1',
      prevHeadSha: 'aaa111',
    });
  });

  // Acceptance 8.
  it('honours a manual full rescan', () => {
    expect(
      decideScanMode({
        base,
        full: true,
        effectivePolicy: ReviewPolicy.ALLOW_AI,
      }),
    ).toMatchObject({
      diffMode: DiffMode.FULL,
      fullReason: FullReason.MANUAL,
      baseScanId: 'scan_1',
    });
  });

  // Acceptance 6.
  it('goes full when the ruleset changed', () => {
    expect(
      decideScanMode({
        base: { ...base, rulesetVersion: '2026.01.1' },
        full: false,
        effectivePolicy: ReviewPolicy.MANUAL_ONLY,
      }).fullReason,
    ).toBe(FullReason.RULESET_CHANGED);
  });

  it('goes full on a prompt change only when the AI runs on the PR', () => {
    const olderPrompt = { ...base, aiPromptVersion: 'ai-2026.09.2' };
    expect(
      decideScanMode({
        base: olderPrompt,
        full: false,
        effectivePolicy: ReviewPolicy.ALLOW_AI,
      }).fullReason,
    ).toBe(FullReason.PROMPT_CHANGED);
    expect(
      decideScanMode({
        base: olderPrompt,
        full: false,
        effectivePolicy: ReviewPolicy.MANUAL_ONLY,
      }).diffMode,
    ).toBe(DiffMode.INCREMENTAL);
  });
});
