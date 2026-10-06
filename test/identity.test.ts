import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, CommandError, deny, passDriver, pause, postMessage, setRole } from "../src/commands.js";
import { saveCredentials } from "../src/credentials.js";
import type { Db } from "../src/db.js";
import { readEvents } from "../src/events.js";
import { gitTools } from "../src/git-tools.js";
import { startServer } from "../src/server.js";
import { createSession } from "../src/sessions.js";
import { fold } from "../src/state.js";
import { driveSession, type WorkerDeps } from "../src/worker.js";
import { deps, FakeGitHub, remoteRepo, say, ScriptedModel, sh, testDb, toolUse } from "./helpers.js";
import type { ModelResponse } from "../src/model.js";

const KEY = Buffer.alloc(32, 7);
const TOKENS = { alice: "ghp_alice_secret_0001", bob: "ghp_bob_secret_0002", carol: "ghp_carol_secret_0003" };

let db: Db;
beforeEach(async () => {
  db = await testDb();
  await db.query("TRUNCATE credentials");
  for (const [user, token] of Object.entries(TOKENS)) {
    await saveCredentials(db, KEY, { userId: user, gitName: user[0].toUpperCase() + user.slice(1), gitEmail: `${user}@example.com`, token });
  }
});
afterEach(async () => {
  await db.end();
});

function gitDeps(model: ScriptedModel, github = new FakeGitHub()): WorkerDeps & { github: FakeGitHub } {
  return { ...deps(db, model, { extraTools: gitTools }), credentialsKey: KEY, github };
}

const log = (sid: string) => readEvents(db, sid);

async function rejects(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CommandError && e.status === status);
}

describe("acting as the person who steered", () => {
  it("authors each commit as whoever was driving when it was asked for", async () => {
    const remote = remoteRepo();
    const sid = await createSession(db, { title: "t", createdBy: "alice", repoUrl: remote });
    await postMessage(db, sid, "alice", "add a README");
    const model = new ScriptedModel([
      toolUse("write_file", { path: "README.md", contents: "# hi\n" }),
      toolUse("git_commit", { message: "Add README" }),
      say("committed"),
      toolUse("write_file", { path: "LICENSE", contents: "MIT\n" }),
      toolUse("git_commit", { message: "Add LICENSE" }),
      say("committed"),
    ]);
    const d = gitDeps(model);
    await driveSession(d, sid);
    await passDriver(db, sid, "alice", "bob");
    await postMessage(db, sid, "bob", "add a license");
    await driveSession(d, sid);

    const work = join(d.workspaceRoot, sid);
    const commits = sh(work, "log", "--format=%an <%ae>|%cn|%s", "-2").split("\n");
    expect(commits).toEqual([
      "Bob <bob@example.com>|Multiplayer Agent|Add LICENSE",
      "Alice <alice@example.com>|Multiplayer Agent|Add README",
    ]);
    expect(sh(work, "log", "-1", "--format=%B")).toContain(`Agent-Session: ${sid}`);
  });

  it("opens PRs and comments with the steerer's own token, never the session creator's", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice", repoUrl: "https://github.com/acme/app" });
    // No clone needed for this test: give the session a local repo already.
    const model = new ScriptedModel([
      toolUse("open_pull_request", { title: "Fix", body: "Fixes it", head: "fix" }),
      say("opened"),
      toolUse("comment_on_pull_request", { number: 7, body: "Rebased" }),
      say("commented"),
    ]);
    const d = gitDeps(model);
    sh(join(d.workspaceRoot), "init", "-q", sid);

    await postMessage(db, sid, "alice", "open the PR");
    await driveSession(d, sid);
    await passDriver(db, sid, "alice", "bob");
    await postMessage(db, sid, "bob", "comment that it's rebased");
    await driveSession(d, sid);

    expect(d.github.calls.map((c) => [c.op, c.token])).toEqual([
      ["pr", TOKENS.alice],
      ["comment", TOKENS.bob],
    ]);
    expect(d.github.calls[0].repo).toEqual({ owner: "acme", name: "app" });
    expect(d.github.calls[0].body).toContain(`for @alice in session ${sid}`);
  });

  it("refuses to act for someone without credentials instead of borrowing another person's", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice", repoUrl: "https://github.com/acme/app" });
    const model = new ScriptedModel([toolUse("comment_on_pull_request", { number: 7, body: "lgtm" }), say("couldn't")]);
    const d = gitDeps(model);
    sh(d.workspaceRoot, "init", "-q", sid);
    await passDriver(db, sid, "alice", "dave");
    await postMessage(db, sid, "dave", "say lgtm on #7");
    await driveSession(d, sid);

    expect(d.github.calls).toEqual([]);
    const finished = (await log(sid)).find((e) => e.type === "tool_finished")!;
    expect(finished.payload).toMatchObject({ isError: true });
    expect(JSON.stringify(finished.payload)).toContain("dave hasn't connected a GitHub account");
  });

  it("never writes a token into the event log or a tool's output", async () => {
    const remote = remoteRepo();
    const sid = await createSession(db, { title: "t", createdBy: "alice", repoUrl: remote });
    await postMessage(db, sid, "alice", "push a branch");
    const model = new ScriptedModel([
      toolUse("git_create_branch", { name: "feature" }),
      toolUse("write_file", { path: "a.txt", contents: "a" }),
      toolUse("git_commit", { message: "a" }),
      toolUse("git_push", { branch: "feature" }),
      say("pushed"),
    ]);
    await driveSession(gitDeps(model), sid);

    expect(sh(remote, "log", "feature", "--format=%an", "-1")).toBe("Alice");
    const everything = JSON.stringify(await log(sid)) + JSON.stringify(model.requests);
    for (const t of Object.values(TOKENS)) {
      expect(everything).not.toContain(t);
      expect(everything).not.toContain(Buffer.from(`x-access-token:${t}`).toString("base64"));
    }
    const raw = await db.query("SELECT token_enc::text AS t FROM credentials");
    expect(raw.rows.map((r) => r.t).join()).not.toContain("ghp_");
  });
});

describe("approval gates", () => {
  const withId = (res: ModelResponse, id?: string): ModelResponse =>
    id ? { ...res, content: res.content.map((b) => (b.type === "tool_use" ? { ...b, id } : b)) } : res;

  async function pushToMainSession(pushId?: string) {
    const remote = remoteRepo();
    const sid = await createSession(db, { title: "t", createdBy: "alice", repoUrl: remote });
    await setRole(db, sid, "alice", "carol", "maintainer");
    await postMessage(db, sid, "alice", "ship it to main");
    const model = new ScriptedModel([
      toolUse("write_file", { path: "fix.txt", contents: "fixed" }),
      toolUse("git_commit", { message: "Fix" }),
      withId(toolUse("git_push", { branch: "main" }), pushId),
      say("pushed to main"),
    ]);
    const d = gitDeps(model);
    expect(await driveSession(d, sid)).toBe("idle");
    return { sid, remote, model, d };
  }

  it("holds a push to main until a second maintainer approves, then pushes as the steerer", async () => {
    const { sid, remote, model, d } = await pushToMainSession();
    const state = fold(await log(sid));
    expect(state.next.kind).toBe("awaiting_approval");
    expect(state.approvals).toMatchObject([{ tool: "git_push", requestedFor: "alice", minRole: "maintainer", allowSelf: false }]);
    expect(sh(remote, "log", "main", "--format=%s", "-1")).toBe("initial");
    const toolUseId = state.approvals[0].toolUseId;

    await rejects(approve(db, sid, "bob", toolUseId), 403); // a member
    await rejects(approve(db, sid, "alice", toolUseId), 403); // asked for it herself
    await approve(db, sid, "carol", toolUseId);
    await driveSession(d, sid);

    expect(sh(remote, "log", "main", "--format=%an|%s", "-1")).toBe("Alice|Fix");
    const finished = (await log(sid)).filter((e) => e.type === "tool_finished").at(-1)!;
    expect(finished.payload).toMatchObject({ isError: false, output: expect.stringContaining("approved by carol") });
    expect(model.requests).toHaveLength(4);
  });

  it("applies exactly one decision when approve and deny race", async () => {
    for (let i = 0; i < 5; i++) {
      const { sid } = await pushToMainSession();
      const toolUseId = fold(await log(sid)).approvals[0].toolUseId;
      const results = await Promise.allSettled([
        approve(db, sid, "carol", toolUseId),
        deny(db, sid, "carol", toolUseId, "not today"),
        approve(db, sid, "carol", toolUseId),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const decisions = (await log(sid)).filter((e) => e.type === "approval_granted" || e.type === "approval_denied");
      expect(decisions).toHaveLength(1);
    }
  });

  it("tells the model who denied a call and why, and pushes nothing", async () => {
    const { sid, remote, model, d } = await pushToMainSession();
    const toolUseId = fold(await log(sid)).approvals[0].toolUseId;
    await deny(db, sid, "carol", toolUseId, "open a PR instead");
    await driveSession(d, sid);

    expect(sh(remote, "log", "main", "--format=%s", "-1")).toBe("initial");
    expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain("not run: carol denied it: open a PR instead");
  });

  it("cancels a pending approval when someone pauses", async () => {
    const { sid } = await pushToMainSession();
    const toolUseId = fold(await log(sid)).approvals[0].toolUseId;
    await pause(db, sid, "bob");
    await rejects(approve(db, sid, "carol", toolUseId), 409);
    expect(fold(await log(sid)).approvals).toEqual([]);
  });

  it("checks the approver's role at the moment they approve", async () => {
    const { sid } = await pushToMainSession();
    const toolUseId = fold(await log(sid)).approvals[0].toolUseId;
    await setRole(db, sid, "alice", "carol", "member");
    await rejects(approve(db, sid, "carol", toolUseId), 403);
  });

  it("enforces the same rules over HTTP", async () => {
    // Other providers' call ids can hold characters Anthropic's never do.
    const { sid } = await pushToMainSession("functions.git_push:2");
    const toolUseId = fold(await log(sid)).approvals[0].toolUseId;
    const server = await startServer(db, { credentialsKey: KEY });
    try {
      const decide = (user: string, what: string, body = {}) =>
        fetch(`${server.url}/sessions/${sid}/approvals/${encodeURIComponent(toolUseId)}/${what}?as=${user}`, { method: "POST", body: JSON.stringify(body) });
      expect((await decide("bob", "approve")).status).toBe(403);
      expect((await decide("alice", "approve")).status).toBe(403);
      expect((await decide("bob", "deny", { reason: "not yours" })).status).toBe(403);
      expect((await decide("carol", "approve")).status).toBe(201);
      expect((await decide("carol", "deny")).status).toBe(409); // already decided
      const roles = (user: string, body: object) =>
        fetch(`${server.url}/sessions/${sid}/roles?as=${user}`, { method: "POST", body: JSON.stringify(body) });
      expect((await roles("bob", { user: "bob", role: "maintainer" })).status).toBe(403);
      expect((await roles("alice", { user: "bob", role: "owner" })).status).toBe(409);
      expect((await roles("alice", { user: "bob", role: "viewer" })).status).toBe(201);
    } finally {
      await server.close();
    }
    expect(fold(await log(sid)).roleOf("bob")).toBe("viewer");
  });

  it("doesn't gate pushes to other branches", async () => {
    const remote = remoteRepo();
    const sid = await createSession(db, { title: "t", createdBy: "alice", repoUrl: remote });
    await postMessage(db, sid, "alice", "push a branch");
    const model = new ScriptedModel([toolUse("git_push", { branch: "wip" }), say("pushed")]);
    await driveSession(gitDeps(model), sid);
    expect(types(await log(sid))).not.toContain("approval_requested");
    expect(sh(remote, "branch", "--list", "wip")).toContain("wip");
  });
});

describe("connecting GitHub", () => {
  it("stores the token encrypted and never sends it back", async () => {
    const server = await startServer(db, { credentialsKey: KEY });
    const token = "ghp_dave_secret_0004";
    try {
      const me = async (user: string) => (await fetch(`${server.url}/me?as=${user}`)).json();
      expect(await me("dave")).toEqual({ user: "dave", githubConnected: false });
      const res = await fetch(`${server.url}/me/github?as=dave`, {
        method: "PUT",
        body: JSON.stringify({ token, name: "Dave", email: "dave@example.com" }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(token);
      expect(await me("dave")).toEqual({ user: "dave", githubConnected: true });
      expect(await me("erin")).toEqual({ user: "erin", githubConnected: false });
    } finally {
      await server.close();
    }
    const { rows } = await db.query("SELECT token_enc FROM credentials WHERE user_id = 'dave'");
    expect(rows[0].token_enc.includes(Buffer.from(token))).toBe(false);

    // A server without a key refuses rather than storing tokens in the clear.
    const keyless = await startServer(db);
    try {
      const res = await fetch(`${keyless.url}/me/github?as=erin`, {
        method: "PUT",
        body: JSON.stringify({ token, name: "Erin", email: "erin@example.com" }),
      });
      expect(res.status).toBe(503);
    } finally {
      await keyless.close();
    }
  });
});

describe("roles", () => {
  it("only lets maintainers change roles, and never removes the last one", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await rejects(setRole(db, sid, "bob", "bob", "maintainer"), 403);
    await rejects(setRole(db, sid, "alice", "alice", "member"), 409);
    await setRole(db, sid, "alice", "bob", "maintainer");
    await setRole(db, sid, "bob", "alice", "member");
    expect(fold(await log(sid)).roleOf("alice")).toBe("member");
  });

  it("lets viewers watch but not steer", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await setRole(db, sid, "alice", "eve", "viewer");
    await rejects(postMessage(db, sid, "eve", "delete everything"), 403);
    await rejects(pause(db, sid, "eve"), 403);
    await rejects(passDriver(db, sid, "alice", "eve"), 409);
  });
});

const types = (events: { type: string }[]) => events.map((e) => e.type);
