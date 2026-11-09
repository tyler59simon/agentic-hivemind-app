// Recent commits and pull requests for a project's repos. Rust looks the repo paths up in
// Living Memory and runs git/gh read-only; the webview only passes the project slug.
import { invoke } from "@tauri-apps/api/core";

export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
}

export interface RepoActivity {
  repo: string;
  commits: Commit[] | null;
  error: string | null;
  prs: PullRequest[] | null;
  prsError: string | null;
}

export function gitActivity(slug: string): Promise<RepoActivity[]> {
  return invoke<RepoActivity[]>("git_activity", { slug });
}
