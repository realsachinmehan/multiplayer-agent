import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Credentials } from "./credentials.js";
import { parseGitHubRepo } from "./github.js";
import { ToolError, type Tool, type ToolContext } from "./tools.js";

const run = promisify(execFile);

export const AGENT_GIT_IDENTITY = { name: "Multiplayer Agent", email: "agent@multiplayer-agent.invalid" };

/**
 * The credentials of the person the agent is acting for. There is no
 * fallback: if they haven't connected GitHub, the call fails. Running it as
 * the session's creator, or whoever happens to have a token, is exactly the
 * impersonation this project exists to avoid.
 */
async function actingAs(ctx: ToolContext): Promise<Credentials> {
  const user = ctx.onBehalfOf;
  if (!user) throw new ToolError("no person asked for this, so there is nobody to act as");
  const creds = await ctx.credentials(user);
  if (!creds) {
    throw new ToolError(
      `${user} hasn't connected a GitHub account, so the agent can't do this as them. ` +
        `${user} can connect one, or someone who has can take the wheel.`,
    );
  }
  return creds;
}

/** Runs git in the workspace. Tokens go in through env, never argv, and are scrubbed from output. */
async function git(ctx: ToolContext, args: string[], opts: { creds?: Credentials | null; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: "0",
    // Ignore the server's own git config, so no identity or credential
    // helper from the host leaks into what the agent does.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...opts.env,
  };
  const secrets: string[] = [];
  if (opts.creds) {
    const basic = Buffer.from(`x-access-token:${opts.creds.token}`).toString("base64");
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    });
    secrets.push(opts.creds.token, basic);
  }
  const scrub = (text: string) => secrets.reduce((t, s) => t.split(s).join("***"), text);
  try {
    const { stdout, stderr } = await run("git", args, { cwd: ctx.workspace, env, maxBuffer: 10 * 1024 * 1024 });
    return scrub(`${stdout}${stderr}`).trim();
  } catch (err: any) {
    throw new ToolError(scrub(`git ${args[0]} failed: ${err.stderr || err.message}`).trim());
  }
}

/**
 * Makes sure the workspace holds the session's repository. Cloned as the
 * person the agent is acting for if they have credentials, else anonymously
 * (fine for a public repo). Never with anyone else's.
 */
export async function ensureRepo(ctx: ToolContext): Promise<void> {
  if (existsSync(join(ctx.workspace, ".git"))) return;
  if (!ctx.repo.url) {
    await git(ctx, ["init", "-q", "-b", ctx.repo.defaultBranch]);
    return;
  }
  const creds = ctx.onBehalfOf ? await ctx.credentials(ctx.onBehalfOf) : null;
  await git(ctx, ["clone", "-q", ctx.repo.url, "."], { creds });
}

const str = (description: string) => ({ type: "string", description }) as const;

export const gitTools: Tool[] = [
  {
    definition: {
      name: "git_status",
      description: "Show the current branch, uncommitted changes and the last few commits.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    idempotent: true,
    async run(_input, ctx) {
      const status = await git(ctx, ["status", "--short", "--branch"]);
      const log = await git(ctx, ["log", "--oneline", "-5"]).catch(() => "(no commits yet)");
      return `${status}\n\n${log}`;
    },
  },
  {
    definition: {
      name: "git_create_branch",
      description: "Create a new branch from the current commit and switch to it.",
      input_schema: { type: "object", properties: { name: str("Branch name") }, required: ["name"], additionalProperties: false },
      strict: true,
    },
    idempotent: true,
    async run({ name }, ctx) {
      await git(ctx, ["check-ref-format", "--branch", name]);
      return git(ctx, ["switch", "-c", name]);
    },
  },
  {
    definition: {
      name: "git_commit",
      description:
        "Stage every change in the repository and commit it. The commit is authored by the person who asked for this work.",
      input_schema: { type: "object", properties: { message: str("Commit message") }, required: ["message"], additionalProperties: false },
      strict: true,
    },
    idempotent: false,
    async run({ message }, ctx) {
      const me = await actingAs(ctx);
      await git(ctx, ["add", "-A"]);
      const staged = await git(ctx, ["diff", "--cached", "--name-only"]);
      if (!staged) return "nothing to commit";
      const trailers = [`Agent-Session: ${ctx.sessionId}`, ...(ctx.approvedBy ? [`Approved-By: ${ctx.approvedBy}`] : [])];
      await git(ctx, ["commit", "-q", "-m", `${message.trim()}\n\n${trailers.join("\n")}`], {
        env: {
          GIT_AUTHOR_NAME: me.gitName,
          GIT_AUTHOR_EMAIL: me.gitEmail,
          GIT_COMMITTER_NAME: AGENT_GIT_IDENTITY.name,
          GIT_COMMITTER_EMAIL: AGENT_GIT_IDENTITY.email,
        },
      });
      const sha = await git(ctx, ["rev-parse", "--short", "HEAD"]);
      return `committed ${sha} as ${me.gitName} <${me.gitEmail}>:\n${staged}`;
    },
  },
  {
    definition: {
      name: "git_push",
      description: "Push the current commit to a branch on the remote, as the person who asked for this work.",
      input_schema: { type: "object", properties: { branch: str("Remote branch to push to") }, required: ["branch"], additionalProperties: false },
      strict: true,
    },
    // Pushing the same commit again is a no-op, and nothing here forces.
    idempotent: true,
    approval({ branch }, { defaultBranch }) {
      return branch === defaultBranch
        ? { minRole: "maintainer", allowSelf: false, reason: `pushes straight to ${defaultBranch}` }
        : null;
    },
    async run({ branch }, ctx) {
      const me = await actingAs(ctx);
      await git(ctx, ["check-ref-format", "--branch", branch]);
      const out = await git(ctx, ["push", "origin", `HEAD:refs/heads/${branch}`], { creds: me });
      return `pushed to ${branch} as ${me.userId}${ctx.approvedBy ? `, approved by ${ctx.approvedBy}` : ""}\n${out}`;
    },
  },
  {
    definition: {
      name: "open_pull_request",
      description: "Open a GitHub pull request from a pushed branch, as the person who asked for this work.",
      input_schema: {
        type: "object",
        properties: { title: str("PR title"), body: str("PR description"), head: str("Branch with the changes"), base: str("Branch to merge into; defaults to the repository's default branch") },
        required: ["title", "body", "head"],
        additionalProperties: false,
      },
    },
    idempotent: false,
    async run({ title, body, head, base }, ctx) {
      const me = await actingAs(ctx);
      const repo = parseGitHubRepo(ctx.repo.url);
      if (!repo) throw new ToolError("this session's repository isn't on GitHub");
      const footer = `\n\n---\nOpened by the multiplayer agent for @${me.userId} in session ${ctx.sessionId}.`;
      const pr = await ctx.github.createPullRequest(me.token, repo, {
        title,
        body: `${body}${footer}`,
        head,
        base: base ?? ctx.repo.defaultBranch,
      });
      return `opened #${pr.number} as ${me.userId}: ${pr.url}`;
    },
  },
  {
    definition: {
      name: "comment_on_pull_request",
      description: "Comment on a GitHub pull request, as the person who asked for this work.",
      input_schema: {
        type: "object",
        properties: { number: { type: "integer", description: "PR number" }, body: str("Comment text") },
        required: ["number", "body"],
        additionalProperties: false,
      },
      strict: true,
    },
    idempotent: false,
    async run({ number, body }, ctx) {
      const me = await actingAs(ctx);
      const repo = parseGitHubRepo(ctx.repo.url);
      if (!repo) throw new ToolError("this session's repository isn't on GitHub");
      const c = await ctx.github.commentOnPullRequest(me.token, repo, number, body);
      return `commented on #${number} as ${me.userId}: ${c.url}`;
    },
  },
];
