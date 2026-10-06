import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { connect, migrate, type Db } from "../src/db.js";
import type { GitHubApi, RepoRef } from "../src/github.js";
import type { Model, ModelRequest, ModelResponse } from "../src/model.js";
import { fileTools, registry, type Tool } from "../src/tools.js";
import type { WorkerDeps } from "../src/worker.js";

export async function testDb(): Promise<Db> {
  const db = connect(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/mpagent_test");
  await migrate(db);
  await db.query("TRUNCATE presence, events, session_leases, summary_claims, sessions");
  return db;
}

/**
 * A model that plays back a fixed list of turns and records every prompt it
 * was sent, so tests can assert exactly what the model saw.
 */
export class ScriptedModel implements Model {
  requests: ModelRequest[] = [];
  constructor(private turns: Array<ModelResponse | ((req: ModelRequest) => Promise<ModelResponse>)>) {}

  async next(req: ModelRequest): Promise<ModelResponse> {
    // Deep copy: the worker builds a fresh array each step, but be safe.
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) throw new Error("ScriptedModel ran out of turns");
    return typeof turn === "function" ? turn(req) : turn;
  }
}

let ids = 0;
export function toolUse(name: string, input: unknown): ModelResponse {
  const block = { type: "tool_use", id: `toolu_${++ids}`, name, input } as Anthropic.Beta.BetaToolUseBlock;
  return { content: [block], stopReason: "tool_use" };
}

export function say(text: string): ModelResponse {
  return { content: [{ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock], stopReason: "end_turn" };
}

export function deps(db: Db, model: Model, extra: Partial<WorkerDeps> & { extraTools?: Tool[] } = {}): WorkerDeps {
  const { extraTools = [], ...rest } = extra;
  return {
    db,
    model,
    tools: registry([...fileTools, ...extraTools]),
    workerId: "worker-a",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mpagent-")),
    leaseTtlMs: 5_000,
    ...rest,
  };
}

/** A promise you can resolve from outside, for pausing a tool or model mid-call. */
export function gate<T = void>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => (open = r));
  return { promise, open };
}

export async function expireLease(db: Db, sessionId: string) {
  await db.query("UPDATE session_leases SET expires_at = now() - interval '1 second' WHERE session_id = $1", [sessionId]);
}

/** Records every GitHub call with the token it was made with. */
export class FakeGitHub implements GitHubApi {
  calls: Array<{ op: string; token: string; repo: RepoRef; body: string }> = [];
  async createPullRequest(token: string, repo: RepoRef, pr: { title: string; body: string }) {
    this.calls.push({ op: "pr", token, repo, body: pr.body });
    return { number: 7, url: `https://github.com/${repo.owner}/${repo.name}/pull/7` };
  }
  async commentOnPullRequest(token: string, repo: RepoRef, _n: number, body: string) {
    this.calls.push({ op: "comment", token, repo, body });
    return { url: "https://github.com/x/y/pull/7#issuecomment-1" };
  }
}

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();

/** A bare repository with one commit on main, standing in for GitHub. */
export function remoteRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mpagent-remote-"));
  const seed = mkdtempSync(join(tmpdir(), "mpagent-seed-"));
  sh(dir, "init", "-q", "--bare", "-b", "main");
  sh(seed, "init", "-q", "-b", "main");
  sh(seed, "-c", "user.name=seed", "-c", "user.email=seed@x", "commit", "-q", "--allow-empty", "-m", "initial");
  sh(seed, "push", "-q", dir, "main");
  return dir;
}
