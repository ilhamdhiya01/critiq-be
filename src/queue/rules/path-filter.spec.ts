import { isIgnoredPath } from './path-filter';

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
});
