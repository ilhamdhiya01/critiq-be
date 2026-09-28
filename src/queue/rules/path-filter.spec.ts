import {
  isDataFixturePath,
  isIgnoredPath,
  isTestLikePath,
} from './path-filter';

describe('isIgnoredPath', () => {
  it.each([
    'yarn.lock',
    'Cargo.lock',
    'pnpm-lock.yaml',
    'apps/web/package-lock.json',
    'public/app.min.js',
    'public/app.js.map',
    'dist/main.js',
    'packages/web/dist/main.js',
    'node_modules/lodash/index.js',
    'vendor/github.com/x/y.go',
    'src/__snapshots__/a.test.ts.snap',
    'assets/Logo.PNG',
    'fonts/inter.woff2',
  ])('ignores %s', (path) => {
    expect(isIgnoredPath(path)).toBe(true);
  });

  it.each([
    'src/main.ts',
    'src/distribution/service.ts',
    'src/vendors.ts',
    'Dockerfile',
  ])('keeps %s', (path) => {
    expect(isIgnoredPath(path)).toBe(false);
  });

  // The whole point of { dot: true }: without it minimatch refuses to match
  // a leading-dot segment with any wildcard, and the highest-signal file in
  // the repo would be invisible to every glob list.
  it.each(['.env', '.env.production', '.github/workflows/ci.yml'])(
    'keeps dotfile %s scannable',
    (path) => {
      expect(isIgnoredPath(path)).toBe(false);
    },
  );
});

describe('isTestLikePath', () => {
  it.each([
    'src/payment.test.ts',
    'src/payment.spec.ts',
    'pkg/payment_test.go',
    'tests/test_payment.py',
    '.env.example',
    'config.sample.yml',
    'docs/setup.md',
    'src/__tests__/auth.ts',
    'test/helpers.ts',
    'spec/models/user_spec.rb',
    'src/Button.stories.tsx',
    'src/queue/rules/fixtures/secret.github_token/positive-1.ts',
    'src/queue/rules/test-helpers.ts',
    'lib/test_utils.py',
  ])('treats %s as test-like', (path) => {
    expect(isTestLikePath(path)).toBe(true);
  });

  it.each([
    'src/payment.ts',
    'src/config/database.ts',
    'apps/api/Dockerfile',
    // Deliberately not documentation: a key pasted into a .txt is a real leak.
    'secrets/key.txt',
  ])('treats %s as production code', (path) => {
    expect(isTestLikePath(path)).toBe(false);
  });

  // MUST_SCAN_GLOBS overrides the test-like list — without dragging
  // .env.example back in.
  it.each([
    '.env',
    '.env.production',
    'test/e2e/.env',
    'tests/docker-compose.yml',
    'infra/main.tf',
    'app.properties',
  ])('never treats config file %s as test-like', (path) => {
    expect(isTestLikePath(path)).toBe(false);
  });

  it.each(['.env.example', '.env.sample'])(
    'still treats %s as test-like despite the .env override',
    (path) => {
      expect(isTestLikePath(path)).toBe(true);
    },
  );

  it('treats a data fixture as test-like even when its name is a config file', () => {
    expect(isTestLikePath('src/rules/fixtures/leak/docker-compose.yml')).toBe(
      true,
    );
  });
});

describe('isDataFixturePath', () => {
  it.each(['src/queue/rules/fixtures/a.ts', 'pkg/testdata/sample.json'])(
    'recognises %s',
    (path) => {
      expect(isDataFixturePath(path)).toBe(true);
    },
  );

  it.each(['src/auth.spec.ts', 'test/helpers.ts'])('rejects %s', (path) => {
    expect(isDataFixturePath(path)).toBe(false);
  });
});
