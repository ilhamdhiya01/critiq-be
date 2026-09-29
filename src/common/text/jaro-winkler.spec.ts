import { jaroWinkler, normalizeTitle } from './jaro-winkler';

describe('jaroWinkler', () => {
  // Reference values from Winkler (1990) / the usual worked examples.
  it.each([
    ['martha', 'marhta', 0.9611],
    ['dwayne', 'duane', 0.84],
    ['dixon', 'dicksonx', 0.8133],
    ['crate', 'trace', 0.7333],
    ['abc', 'xyz', 0],
  ])('%s vs %s ≈ %f', (a, b, expected) => {
    expect(jaroWinkler(a, b)).toBeCloseTo(expected, 3);
  });

  it('is 1 for identical strings and 0 against an empty one', () => {
    expect(jaroWinkler('same', 'same')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
  });
});

describe('normalizeTitle', () => {
  it('lowercases and drops punctuation and digits', () => {
    expect(normalizeTitle('  Swallowed promise-rejection (v2)! ')).toBe(
      'swallowed promise rejection v',
    );
  });
});
