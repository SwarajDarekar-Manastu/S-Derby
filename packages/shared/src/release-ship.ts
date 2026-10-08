/** Shipping approved work from a repository's `release` branch to `main`. */

export const RELEASE_SHIP_TOKEN_SECRET_NAME = "BOARD_SHIP_GITHUB_TOKEN";

export interface ReleaseShipCommit {
  sha: string;
  message: string;
  author: string | null;
  url: string;
}

export interface ReleaseShipRepo {
  /** `owner/name` on github.com. */
  repo: string;
  aheadBy: number;
  commits: ReleaseShipCommit[];
  openPullRequestUrl: string | null;
  error: string | null;
}

export interface ReleaseShipStatus {
  /** Whether the Board's GitHub token secret exists, so shipping can run. */
  tokenConfigured: boolean;
  repos: ReleaseShipRepo[];
}

export interface ReleaseShipResult {
  repo: string;
  pullRequestUrl: string;
  mergeCommitSha: string;
  shippedCommits: number;
}
