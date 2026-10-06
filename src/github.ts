/** The GitHub calls the agent makes, always with a specific person's token. */
export interface GitHubApi {
  createPullRequest(
    token: string,
    repo: RepoRef,
    pr: { title: string; body: string; head: string; base: string },
  ): Promise<{ number: number; url: string }>;
  commentOnPullRequest(token: string, repo: RepoRef, number: number, body: string): Promise<{ url: string }>;
}

export type RepoRef = { owner: string; name: string };

/** owner/name from https://github.com/owner/name(.git), or null for other remotes. */
export function parseGitHubRepo(url: string | null): RepoRef | null {
  const m = url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

export class RestGitHub implements GitHubApi {
  constructor(private base = "https://api.github.com") {}

  private async call(token: string, method: string, path: string, body: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${data.message ?? ""}`.trim());
    return data;
  }

  async createPullRequest(token: string, repo: RepoRef, pr: { title: string; body: string; head: string; base: string }) {
    const data = await this.call(token, "POST", `/repos/${repo.owner}/${repo.name}/pulls`, pr);
    return { number: data.number, url: data.html_url };
  }

  async commentOnPullRequest(token: string, repo: RepoRef, number: number, body: string) {
    const data = await this.call(token, "POST", `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, { body });
    return { url: data.html_url };
  }
}
