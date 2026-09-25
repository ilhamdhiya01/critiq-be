import { IGNORE_GLOBS } from './rules.constants';

export function isIgnoredPath(
  filePath: string,
  globs: string[] = IGNORE_GLOBS,
): boolean {
  const segments = filePath.split('/');
  const basename = (segments.at(-1) ?? filePath).toLowerCase();

  return globs.some((glob) => {
    if (glob.startsWith('*.')) {
      return basename.endsWith(glob.slice(1).toLowerCase());
    }
    if (glob.endsWith('/**')) {
      // Matches the directory at any depth — packages/web/dist/app.js is
      // just as generated as a top-level dist/app.js.
      const dir = glob.slice(0, -3);
      return segments.slice(0, -1).includes(dir);
    }
    return basename === glob.toLowerCase();
  });
}
