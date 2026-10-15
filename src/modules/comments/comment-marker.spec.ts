import {
  markerOf,
  providerBody,
  stripCritiqFraming,
  withMarker,
} from './comment-marker';

describe('comment marker', () => {
  it('finds the Critiq id in a body it marked', () => {
    expect(markerOf(withMarker('hello', 'cmabc123'))).toBe('cmabc123');
    expect(markerOf('a comment written on GitHub')).toBeNull();
  });

  it('names the author and quotes the thread on a GitHub reply', () => {
    expect(providerBody('Ilham', 'Done', 'c1', 'line one\nline two')).toBe(
      '**Ilham** via Critiq:\n\n> line one\n> line two\n\nDone\n\n<!-- critiq:comment:c1 -->',
    );
  });

  // A Critiq comment edited on the provider comes back with its framing.
  it('strips the framing to get the comment back', () => {
    expect(stripCritiqFraming(providerBody('Ilham', 'Edited text', 'c1'))).toBe(
      'Edited text',
    );
  });
});
