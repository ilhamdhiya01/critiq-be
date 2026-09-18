// Field names (`path`, `lang`) deliberately match GitlabCandidateDto so the
// frontend can share one repo-picker component across both providers.
// `private` is kept as GitHub's own boolean rather than force-unified with
// GitLab's visibility string enum — the two don't carry the same semantics.
export class GithubCandidateDto {
  id!: number;
  path!: string;
  lang!: string | null;
  private!: boolean;

  constructor(partial: {
    id: number;
    path: string;
    lang: string | null;
    private: boolean;
  }) {
    Object.assign(this, partial);
  }
}
