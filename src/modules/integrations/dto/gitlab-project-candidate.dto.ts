export class GitlabProjectCandidateDto {
  id: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  visibility: string;

  constructor(project: {
    id: number;
    name: string;
    path_with_namespace: string;
    web_url: string;
    visibility: string;
  }) {
    this.id = project.id;
    this.name = project.name;
    this.pathWithNamespace = project.path_with_namespace;
    this.webUrl = project.web_url;
    this.visibility = project.visibility;
  }
}
