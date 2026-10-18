// The things Axelvon can do on GitHub, using the personal access token the person saved.
//
// Reading runs on its own. Anything that writes (an issue, a comment, a file, a branch, a pull
// request) is risky and waits for the person to approve it. Nothing here deletes a repository,
// a branch or a file.
import {
  defineTool,
  failureDetail,
  jsonRequest,
  limit,
  optionalText,
  requiredText,
  savedToken,
  shorten,
  ToolError,
} from "./tool-kit.ts";
import type { Args, Tool, ToolContext } from "./tool-kit.ts";

const API = "https://api.github.com";
const MAX_FILE_CHARS = 8000;
const MAX_TEXT_CHARS = 1500;
const RECONNECT_HINT = "Ask the person to reconnect GitHub in Settings → Connections.";

/* ---------- Talking to GitHub ---------- */

async function github(ctx: ToolContext, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await savedToken(ctx, "github", "GitHub");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Axelvon",
    },
    signal: ctx.signal,
  });
  if (response.ok) return response;

  const detail = await failureDetail(response);
  console.error("GitHub request failed with status", response.status);
  if (response.status === 401) throw new ToolError(`GitHub rejected the saved token. ${RECONNECT_HINT}`);
  if (response.status === 404) throw new ToolError("GitHub could not find that (or the token has no access to it).");
  if (response.status === 403) throw new ToolError(`GitHub refused the request, probably a missing permission. ${detail}`.trim());
  throw new ToolError(`GitHub returned an error (${response.status}). ${detail}`.trim());
}

async function githubJson(ctx: ToolContext, path: string, init: RequestInit = {}) {
  return await (await github(ctx, path, init)).json();
}

/* ---------- Checking the AI's input ---------- */

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9_./-]{1,200}$/;

function requiredRepo(args: Args): string {
  const repo = requiredText(args, "repo", 201);
  if (!REPO_PATTERN.test(repo)) throw new ToolError(`"repo" must look like owner/name.`);
  return repo;
}

function optionalBranch(args: Args, key: string): string | undefined {
  const branch = optionalText(args, key, 200);
  if (branch === undefined) return undefined;
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..")) throw new ToolError(`"${key}" is not a valid branch name.`);
  return branch;
}

function requiredBranch(args: Args, key: string): string {
  const branch = optionalBranch(args, key);
  if (!branch) throw new ToolError(`"${key}" is required.`);
  return branch;
}

// A file path inside a repository. Empty means the top folder.
function filePath(args: Args, required: boolean): string {
  const text = required ? requiredText(args, "path", 300) : optionalText(args, "path", 300) ?? "";
  const clean = text.replace(/^\/+/, "");
  if (clean.split("/").some((part) => part === ".." || part === ".")) throw new ToolError(`"path" cannot contain "." or ".." parts.`);
  return clean;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function issueNumber(args: Args): number {
  const value = Number(args.number);
  if (!Number.isInteger(value) || value < 1 || value > 10_000_000) throw new ToolError(`"number" must be an issue number.`);
  return value;
}

/* ---------- Text helpers ---------- */

function decodeBase64(text: string): string {
  const binary = atob(text.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function encodeBase64(text: string): string {
  let binary = "";
  new TextEncoder().encode(text).forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

type RepoFile = { type?: string; sha?: string; content?: string; encoding?: string; size?: number };

// Looks up a file; returns null when it does not exist yet.
async function findFile(ctx: ToolContext, repo: string, path: string, ref?: string): Promise<RepoFile | RepoFile[] | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    return await githubJson(ctx, `/repos/${repo}/contents/${encodePath(path)}${query}`);
  } catch (error) {
    if (error instanceof ToolError && error.message.startsWith("GitHub could not find")) return null;
    throw error;
  }
}

/* ---------- Reading ---------- */

const listRepos = defineTool({
  name: "github_list_repos",
  provider: "github",
  description: "List the person's GitHub repositories, most recently updated first.",
  parameters: {
    type: "object",
    properties: { max_results: { type: "number", description: "How many repositories, 1 to 30. Default 15." } },
  },
  risky: false,
  parse: (raw) => ({ count: limit(raw, "max_results", 15, 30) }),
  async run({ count }, ctx) {
    const repos = await githubJson(ctx, `/user/repos?sort=updated&per_page=${count}`);
    return (repos as Record<string, unknown>[]).map((repo) => ({
      name: repo.full_name,
      private: repo.private,
      description: repo.description,
      default_branch: repo.default_branch,
      updated: repo.updated_at,
    }));
  },
});

const searchCode = defineTool({
  name: "github_search_code",
  provider: "github",
  description: "Search code on GitHub, optionally inside one repository.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The text to look for." },
      repo: { type: "string", description: "Optional owner/name to search inside." },
    },
    required: ["query"],
  },
  risky: false,
  parse: (raw) => ({
    query: requiredText(raw, "query", 200),
    repo: raw.repo === undefined || raw.repo === "" ? undefined : requiredRepo(raw),
  }),
  async run({ query, repo }, ctx) {
    const q = repo ? `${query} repo:${repo}` : query;
    const data = await githubJson(ctx, `/search/code?q=${encodeURIComponent(q)}&per_page=10`);
    return ((data.items || []) as Record<string, any>[]).map((item) => ({
      repo: item.repository?.full_name,
      path: item.path,
      link: item.html_url,
    }));
  },
});

const readFile = defineTool({
  name: "github_read_file",
  provider: "github",
  description: "Read one file from a repository, or list the files in a folder (leave path empty for the top folder).",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      path: { type: "string", description: "File or folder path inside the repository." },
      branch: { type: "string", description: "Optional branch, tag or commit." },
    },
    required: ["repo"],
  },
  risky: false,
  parse: (raw) => ({ repo: requiredRepo(raw), path: filePath(raw, false), branch: optionalBranch(raw, "branch") }),
  async run({ repo, path, branch }, ctx) {
    const found = await findFile(ctx, repo, path, branch);
    if (!found) throw new ToolError("GitHub could not find that file or folder.");
    if (Array.isArray(found)) {
      return (found as Record<string, unknown>[]).map((item) => ({ name: item.name, type: item.type, size: item.size }));
    }
    if (found.type !== "file" || found.encoding !== "base64" || typeof found.content !== "string") {
      throw new ToolError("That item is not a readable text file.");
    }
    return { path, size: found.size, content: shorten(decodeBase64(found.content), MAX_FILE_CHARS) };
  },
});

const listIssues = defineTool({
  name: "github_list_issues",
  provider: "github",
  description: "List issues in a repository (pull requests are left out).",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
      max_results: { type: "number", description: "1 to 30. Default 15." },
    },
    required: ["repo"],
  },
  risky: false,
  parse: (raw) => {
    const state = optionalText(raw, "state", 10) ?? "open";
    if (!["open", "closed", "all"].includes(state)) throw new ToolError(`"state" must be open, closed or all.`);
    return { repo: requiredRepo(raw), state, count: limit(raw, "max_results", 15, 30) };
  },
  async run({ repo, state, count }, ctx) {
    const issues = (await githubJson(ctx, `/repos/${repo}/issues?state=${state}&per_page=${count}`)) as Record<string, any>[];
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.user?.login,
        comments: issue.comments,
        link: issue.html_url,
      }));
  },
});

const readIssue = defineTool({
  name: "github_read_issue",
  provider: "github",
  description: "Read one issue or pull request with its first comments.",
  parameters: {
    type: "object",
    properties: { repo: { type: "string", description: "owner/name" }, number: { type: "number", description: "The issue number." } },
    required: ["repo", "number"],
  },
  risky: false,
  parse: (raw) => ({ repo: requiredRepo(raw), number: issueNumber(raw) }),
  async run({ repo, number }, ctx) {
    const issue = await githubJson(ctx, `/repos/${repo}/issues/${number}`);
    const comments = (await githubJson(ctx, `/repos/${repo}/issues/${number}/comments?per_page=10`)) as Record<string, any>[];
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login,
      body: shorten(String(issue.body || ""), MAX_TEXT_CHARS),
      comments: comments.map((comment) => ({ author: comment.user?.login, body: shorten(String(comment.body || ""), 600) })),
    };
  },
});

/* ---------- Writing (always asks first) ---------- */

const createIssue = defineTool({
  name: "github_create_issue",
  provider: "github",
  description: "Open a new issue in a repository. The person must approve it first.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      title: { type: "string", description: "The issue title." },
      body: { type: "string", description: "The issue text (markdown)." },
    },
    required: ["repo", "title"],
  },
  risky: true,
  parse: (raw) => ({ repo: requiredRepo(raw), title: requiredText(raw, "title", 250), body: optionalText(raw, "body", 10000) ?? "" }),
  async describe({ repo, title, body }) {
    return `Open an issue in ${repo}\nTitle: ${title}${body ? `\n${shorten(body, 400)}` : ""}`;
  },
  async run({ repo, title, body }, ctx) {
    const issue = await githubJson(ctx, `/repos/${repo}/issues`, jsonRequest("POST", { title, body }));
    return { number: issue.number, link: issue.html_url };
  },
});

const commentIssue = defineTool({
  name: "github_comment",
  provider: "github",
  description: "Add a comment to an issue or pull request. The person must approve it first.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "number", description: "The issue or pull request number." },
      body: { type: "string", description: "The comment (markdown)." },
    },
    required: ["repo", "number", "body"],
  },
  risky: true,
  parse: (raw) => ({ repo: requiredRepo(raw), number: issueNumber(raw), body: requiredText(raw, "body", 10000) }),
  async describe({ repo, number, body }) {
    return `Comment on ${repo} #${number}\n${shorten(body, 500)}`;
  },
  async run({ repo, number, body }, ctx) {
    const comment = await githubJson(ctx, `/repos/${repo}/issues/${number}/comments`, jsonRequest("POST", { body }));
    return { link: comment.html_url };
  },
});

const setIssueState = defineTool({
  name: "github_set_issue_state",
  provider: "github",
  description: "Close or reopen an issue or pull request. The person must approve it first.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "number", description: "The issue or pull request number." },
      state: { type: "string", enum: ["open", "closed"] },
    },
    required: ["repo", "number", "state"],
  },
  risky: true,
  parse: (raw) => {
    const state = requiredText(raw, "state", 10);
    if (state !== "open" && state !== "closed") throw new ToolError(`"state" must be open or closed.`);
    return { repo: requiredRepo(raw), number: issueNumber(raw), state };
  },
  async describe({ repo, number, state }, ctx) {
    const issue = await githubJson(ctx, `/repos/${repo}/issues/${number}`);
    return `${state === "closed" ? "Close" : "Reopen"} ${repo} #${number}: "${issue.title}"`;
  },
  async run({ repo, number, state }, ctx) {
    await githubJson(ctx, `/repos/${repo}/issues/${number}`, jsonRequest("PATCH", { state }));
    return { state };
  },
});

const writeFile = defineTool({
  name: "github_write_file",
  provider: "github",
  description:
    "Create a file, or replace an existing file's contents, as a commit. Old versions stay in the history. The person must approve it first.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      path: { type: "string", description: "File path inside the repository." },
      content: { type: "string", description: "The full new text of the file." },
      message: { type: "string", description: "The commit message." },
      branch: { type: "string", description: "Branch to commit to. Leave out for the default branch." },
    },
    required: ["repo", "path", "content", "message"],
  },
  risky: true,
  parse: (raw) => ({
    repo: requiredRepo(raw),
    path: filePath(raw, true),
    content: requiredText(raw, "content", 100000),
    message: requiredText(raw, "message", 300),
    branch: optionalBranch(raw, "branch"),
  }),
  async describe({ repo, path, content, message, branch }, ctx) {
    const existing = await findFile(ctx, repo, path, branch);
    const verb = existing ? "Replace the contents of" : "Create";
    return `${verb} ${path} in ${repo} (${branch ? `branch ${branch}` : "default branch"})\nCommit: ${message}\n${content.length} characters, starting: ${shorten(content, 200)}`;
  },
  async run({ repo, path, content, message, branch }, ctx) {
    const existing = await findFile(ctx, repo, path, branch);
    if (Array.isArray(existing)) throw new ToolError("That path is a folder, not a file.");
    const body: Record<string, unknown> = { message, content: encodeBase64(content) };
    if (branch) body.branch = branch;
    if (existing?.sha) body.sha = existing.sha;

    const result = await githubJson(ctx, `/repos/${repo}/contents/${encodePath(path)}`, jsonRequest("PUT", body));
    return { committed: true, link: result.commit?.html_url };
  },
});

const createBranch = defineTool({
  name: "github_create_branch",
  provider: "github",
  description: "Create a new branch from an existing one. The person must approve it first.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      branch: { type: "string", description: "The new branch name." },
      from: { type: "string", description: "Branch to start from. Leave out for the default branch." },
    },
    required: ["repo", "branch"],
  },
  risky: true,
  parse: (raw) => ({ repo: requiredRepo(raw), branch: requiredBranch(raw, "branch"), from: optionalBranch(raw, "from") }),
  async describe({ repo, branch, from }) {
    return `Create branch ${branch} in ${repo}, starting from ${from ?? "the default branch"}`;
  },
  async run({ repo, branch, from }, ctx) {
    const base = from ?? (await githubJson(ctx, `/repos/${repo}`)).default_branch;
    const ref = await githubJson(ctx, `/repos/${repo}/git/ref/heads/${encodePath(base)}`);
    await githubJson(ctx, `/repos/${repo}/git/refs`, jsonRequest("POST", { ref: `refs/heads/${branch}`, sha: ref.object?.sha }));
    return { created: branch };
  },
});

const createPullRequest = defineTool({
  name: "github_create_pull_request",
  provider: "github",
  description: "Open a pull request from one branch into another. The person must approve it first.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      title: { type: "string", description: "The pull request title." },
      head: { type: "string", description: "The branch with the changes." },
      base: { type: "string", description: "The branch to merge into. Leave out for the default branch." },
      body: { type: "string", description: "The description (markdown)." },
    },
    required: ["repo", "title", "head"],
  },
  risky: true,
  parse: (raw) => ({
    repo: requiredRepo(raw),
    title: requiredText(raw, "title", 250),
    head: requiredBranch(raw, "head"),
    base: optionalBranch(raw, "base"),
    body: optionalText(raw, "body", 10000) ?? "",
  }),
  async describe({ repo, title, head, base }) {
    return `Open a pull request in ${repo}: ${head} → ${base ?? "default branch"}\nTitle: ${title}`;
  },
  async run({ repo, title, head, base, body }, ctx) {
    const target = base ?? (await githubJson(ctx, `/repos/${repo}`)).default_branch;
    const pull = await githubJson(ctx, `/repos/${repo}/pulls`, jsonRequest("POST", { title, head, base: target, body }));
    return { number: pull.number, link: pull.html_url };
  },
});

export const GITHUB_TOOLS: Tool[] = [
  listRepos,
  searchCode,
  readFile,
  listIssues,
  readIssue,
  createIssue,
  commentIssue,
  setIssueState,
  writeFile,
  createBranch,
  createPullRequest,
];
