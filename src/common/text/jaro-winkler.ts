// Title similarity for matching a new finding to one resolved in an earlier
// scan of the same PR (v1.5.1 langkah 3). AI titles are free text, so an
// exact match is too strict; Jaro-Winkler weights a shared prefix, which is
// how two phrasings of the same problem usually differ.

// Lowercase, no punctuation or digits, single spaces.
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaro(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const from = Math.max(0, i - window);
    const to = Math.min(b.length - 1, i + window);
    for (let j = from; j <= to; j += 1) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) {
    return 0;
  }

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) {
      continue;
    }
    while (!bMatched[k]) {
      k += 1;
    }
    if (a[i] !== b[k]) {
      transpositions += 1;
    }
    k += 1;
  }

  return (
    (matches / a.length +
      matches / b.length +
      (matches - transpositions / 2) / matches) /
    3
  );
}

const PREFIX_SCALE = 0.1;
const MAX_PREFIX = 4;

export function jaroWinkler(a: string, b: string): number {
  const similarity = jaro(a, b);
  let prefix = 0;
  while (
    prefix < Math.min(MAX_PREFIX, a.length, b.length) &&
    a[prefix] === b[prefix]
  ) {
    prefix += 1;
  }
  return similarity + prefix * PREFIX_SCALE * (1 - similarity);
}
