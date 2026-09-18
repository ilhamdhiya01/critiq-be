export class GitlabCandidateDto {
  id!: number;
  path!: string;
  lang!: string | null;
  visibility!: string;
  accessLevel!: number;

  constructor(partial: {
    id: number;
    path: string;
    lang: string | null;
    visibility: string;
    accessLevel: number;
  }) {
    Object.assign(this, partial);
  }
}
