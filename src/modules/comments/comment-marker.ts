// A comment Critiq sends carries an invisible marker naming its own id, so
// the provider's webhook for it — which comes back a second later — links to
// the row Critiq already has instead of creating a copy (anti-echo). An HTML
// comment renders as nothing on GitHub and GitLab.
const MARKER = /<!--\s*critiq:comment:([a-z0-9]+)\s*-->/i;

export function withMarker(body: string, commentId: string): string {
  return `${body}\n\n<!-- critiq:comment:${commentId} -->`;
}

// The Critiq comment id in a provider comment's body, if it is one of ours.
export function markerOf(body: string): string | null {
  return MARKER.exec(body)?.[1] ?? null;
}

// The text shown on the provider: who wrote it in Critiq, then the comment.
export function providerBody(
  authorName: string,
  body: string,
  commentId: string,
  quote?: string,
): string {
  const quoted = quote
    ? `${quote
        .split('\n')
        .slice(0, 3)
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`
    : '';
  return withMarker(
    `**${authorName}** via Critiq:\n\n${quoted}${body}`,
    commentId,
  );
}

// The comment as written, without what providerBody added — for a comment
// that comes back from the provider edited.
export function stripCritiqFraming(body: string): string {
  return body
    .replace(MARKER, '')
    .replace(/^\*\*[^*]+\*\* via Critiq:\n\n/, '')
    .trim();
}
