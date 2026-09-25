// Extension → language mapping used to decide which rules apply to a file
// (Rule.languages). 'Dockerfile' has no extension at all, so it's matched
// by basename instead — see the special case below.
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: 'js',
  tsx: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  py: 'py',
  go: 'go',
  php: 'php',
  rb: 'rb',
  java: 'java',
  kt: 'java',
};

export function detectLanguage(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath;
  if (basename.toLowerCase().startsWith('dockerfile')) {
    return 'dockerfile';
  }

  const extension = basename.includes('.')
    ? basename.split('.').pop()!.toLowerCase()
    : '';
  return EXTENSION_LANGUAGE_MAP[extension] ?? '*';
}

export function ruleAppliesTo(
  ruleLanguages: string[] | '*',
  fileLanguage: string,
): boolean {
  if (ruleLanguages === '*') {
    return true;
  }
  return ruleLanguages.includes(fileLanguage);
}
