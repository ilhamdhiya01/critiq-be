import { isIgnoredPath, isSecretSkippedPath } from './path-filter';

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

describe('isSecretSkippedPath', () => {
  it.each([
    'src/payment.test.ts',
    'src/payment.spec.ts',
    '.env.example',
    'config.sample.yml',
    'docs/setup.md',
    'src/__tests__/auth.ts',
    'test/helpers.ts',
    'src/queue/rules/fixtures/secret.github_token/positive-1.ts',
  ])('skips secret rules for %s', (path) => {
    expect(isSecretSkippedPath(path)).toBe(true);
  });

  it.each(['src/payment.ts', 'src/config/database.ts', 'apps/api/Dockerfile'])(
    'runs secret rules on %s',
    (path) => {
      expect(isSecretSkippedPath(path)).toBe(false);
    },
  );

  // MUST_SCAN_GLOBS overrides the skip list — and must do so without
  // dragging `.env.example` back in, which acceptance 16 turns on.
  it.each([
    '.env',
    '.env.production',
    'docker-compose.yml',
    'docker-compose.override.yml',
    'infra/main.tf',
    'app.properties',
  ])('always scans %s for secrets', (path) => {
    expect(isSecretSkippedPath(path)).toBe(false);
  });

  it.each(['.env.example', '.env.sample'])(
    'still skips %s despite the .env override',
    (path) => {
      expect(isSecretSkippedPath(path)).toBe(true);
    },
  );
});
