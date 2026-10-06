import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { passDriver, postMessage, requestSummary, setRole, claimDriver } from "../src/commands.js";
import { saveCredentials } from "../src/credentials.js";
import type { Db } from "../src/db.js";
import { readEvents, type SessionEvent } from "../src/events.js";
import { gitTools } from "../src/git-tools.js";
import { sessionsNeedingSummaries, writeSummaries, writeSummary, type SummaryDeps } from "../src/handoff.js";
import type { ModelResponse } from "../src/model.js";
import { startServer } from "../src/server.js";
import { createSession } from "../src/sessions.js";
import { fold } from "../src/state.js";
import { driveSession } from "../src/worker.js";
import { deps, FakeGitHub, gate, remoteRepo, say, ScriptedModel, testDb, toolUse } from "./helpers.js";

const KEY = Buffer.alloc(32, 7);

let db: Db;
beforeEach(async () => {
  db = await testDb();
  await db.query("TRUNCATE credentials");
  for (const user of ["alice", "bob"]) {
    await saveCredentials(db, KEY, { userId: user, gitName: user, gitEmail: `${user}@example.com`, token: `ghp_${user}_0001` });
  }
});
afterEach(async () => {
  await db.end();
});

const noteDeps = (model: ScriptedModel, workerId = "notes-a"): SummaryDeps => ({ db, model, workerId, claimTtlMs: 60_000 });
const log = (sid: string) => readEvents(db, sid);
type Ready = Extract<SessionEvent, { type: "summary_ready" }>;
const notes = async (sid: string) => (await log(sid)).filter((e): e is Ready => e.type === "summary_ready");
const promptOf = (m: ScriptedModel, i = 0) => m.requests[i].messages[0].content as string;

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("asking for handoff notes", () => {
  it("asks for a note for the new driver in the same transaction as every handoff", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const passed = await passDriver(db, sid, "alice", "bob");
    expect(passed.map((e) => e.type)).toEqual(["driver_changed", "summary_requested"]);
    expect(passed[1].payload).toEqual({ for: "bob", reason: "handoff", sinceSeq: 0 });

    // Alice comes back: her note covers what happened since she let go.
    const back = await passDriver(db, sid, "bob", "alice");
    expect(back[1].payload).toEqual({ for: "alice", reason: "handoff", sinceSeq: passed[0].seq });

    const claimed = await claimDriver(db, sid, "carol");
    expect(claimed.at(-1)).toMatchObject({ type: "summary_requested", payload: { for: "carol" } });
  });

  it("lets anyone ask to catch up, viewers too, and doesn't double up", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await setRole(db, sid, "alice", "eve", "viewer");
    const first = await requestSummary(db, sid, "eve");
    expect(first.existing).toBe(false);
    expect(await requestSummary(db, sid, "eve")).toEqual({ requestSeq: first.requestSeq, existing: true });

    const server = await startServer(db);
    try {
      const ask = (user: string, sinceSeq: number) =>
        fetch(`${server.url}/sessions/${sid}/summaries?as=${user}`, { method: "POST", body: JSON.stringify({ sinceSeq }) });
      const res = await ask("frank", 9999);
      expect(res.status).toBe(201);
      const { requestSeq } = await res.json();
      // A sinceSeq past the end of the log is clamped to it.
      const req = fold(await log(sid)).summaryRequests.find((r) => r.seq === requestSeq)!;
      expect(req.sinceSeq).toBe(requestSeq - 1);
      expect((await ask("frank", 0)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("writing handoff notes", () => {
  it("writes the note while the agent keeps working, and says exactly what it saw", async () => {
    const sid = await createSession(db, { title: "flaky test", createdBy: "alice" });
    await postMessage(db, sid, "alice", "write notes.md");
    await driveSession(deps(db, new ScriptedModel([toolUse("write_file", { path: "notes.md", contents: "a" }), say("done")])), sid);
    await passDriver(db, sid, "alice", "bob");

    // The note's model is slow. While it thinks, Bob sets the agent to work.
    const slow = gate<ModelResponse>();
    const writer = new ScriptedModel([() => slow.promise]);
    const writing = writeSummaries(noteDeps(writer), sid);
    await until(() => writer.requests.length === 1);

    await postMessage(db, sid, "bob", "now write more.md");
    const agent = new ScriptedModel([toolUse("write_file", { path: "more.md", contents: "b" }), say("done too")]);
    expect(await driveSession(deps(db, agent), sid)).toBe("idle"); // not held up by the note

    slow.open(say("Goal: notes [#2]."));
    expect(await writing).toBe(1);

    const events = await log(sid);
    const [note] = await notes(sid);
    const bobAsked = events.find((e) => e.type === "user_message" && e.actor === "bob")!;
    // The note covers the log as it stood when the note started, and says so.
    expect(note.payload.upToSeq).toBeLessThan(bobAsked.seq);
    expect(promptOf(writer)).toContain("notes.md");
    expect(promptOf(writer)).not.toContain("more.md");
    expect(note.payload.facts.filesChanged.map((f) => f.path)).toEqual(["notes.md"]);
    // Everything Bob's agent did lands after upToSeq, so readers see it as newer than the note.
    const newer = events.filter((e) => e.seq > note.payload.upToSeq && e.type === "tool_finished");
    expect(newer).toHaveLength(1);
  });

  it("never makes the agent throw away a step when a note lands mid-call", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "say hi");
    const thinking = gate<ModelResponse>();
    const agent = new ScriptedModel([() => thinking.promise]);
    const driving = driveSession(deps(db, agent), sid);
    await until(() => agent.requests.length === 1);

    await requestSummary(db, sid, "bob");
    expect(await writeSummaries(noteDeps(new ScriptedModel([say("Goal: say hi [#2].")])), sid)).toBe(1);

    thinking.open(say("hi"));
    expect(await driving).toBe("idle");
    // A pause or handoff here would discard the answer and ask again. A note doesn't.
    expect(agent.requests).toHaveLength(1);
    expect((await log(sid)).filter((e) => e.type === "model_response")).toHaveLength(1);
  });

  it("keeps notes out of the agent's conversation", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "write a.md");
    await driveSession(deps(db, new ScriptedModel([toolUse("write_file", { path: "a.md", contents: "a" }), say("ok")])), sid);
    await requestSummary(db, sid, "bob");
    await writeSummaries(noteDeps(new ScriptedModel([say("NOTE-TEXT-7731 [#2]")])), sid);

    await postMessage(db, sid, "alice", "thanks");
    const agent = new ScriptedModel([say("you're welcome")]);
    await driveSession(deps(db, agent), sid);
    expect(JSON.stringify(agent.requests)).not.toContain("NOTE-TEXT-7731");
    expect(JSON.stringify(agent.requests)).not.toContain("summary");
  });

  it("writes exactly one note per request, however many workers try", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "do a thing");
    await requestSummary(db, sid, "bob");

    // While worker a holds the claim, worker b leaves the request alone.
    const slow = gate<ModelResponse>();
    const a = new ScriptedModel([() => slow.promise]);
    const b = new ScriptedModel([say("from b")]);
    const first = writeSummaries(noteDeps(a, "notes-a"), sid);
    await until(() => a.requests.length === 1);
    expect(await writeSummaries(noteDeps(b, "notes-b"), sid)).toBe(0);
    expect(b.requests).toHaveLength(0);
    slow.open(say("from a [#2]"));
    expect(await first).toBe(1);

    // A worker that died holding a claim blocks others only until it expires.
    const { requestSeq } = await requestSummary(db, sid, "carol");
    await db.query("INSERT INTO summary_claims VALUES ($1, $2, 'notes-dead', now() + interval '1 minute')", [sid, requestSeq]);
    expect(await writeSummaries(noteDeps(b, "notes-b"), sid)).toBe(0);
    await db.query("UPDATE summary_claims SET expires_at = now() - interval '1 second' WHERE request_seq = $1", [requestSeq]);
    expect(await writeSummaries(noteDeps(b, "notes-b"), sid)).toBe(1);

    // Two writers that both got past the claim still produce one note.
    await requestSummary(db, sid, "dave");
    const [request] = fold(await log(sid)).summaryRequests;
    const results = await Promise.all([
      writeSummary(noteDeps(new ScriptedModel([say("one")]), "same"), sid, request),
      writeSummary(noteDeps(new ScriptedModel([say("two")]), "same"), sid, request),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const written = await notes(sid);
    expect(written.map((n) => n.payload.for)).toEqual(["bob", "carol", "dave"]);
    expect(await sessionsNeedingSummaries(db)).toEqual([]);
  });

  it("drops citations to events the note never saw", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "add a README");
    await requestSummary(db, sid, "bob");
    await writeSummaries(noteDeps(new ScriptedModel([say("Goal: a README [#2]. Done: everything [#999]. In flight: idle [#0].")])), sid);
    const [note] = await notes(sid);
    expect(note.payload.text).toBe("Goal: a README [#2]. Done: everything. In flight: idle.");
    expect(note.payload.droppedCitations).toEqual([999, 0]);
  });

  it("keeps citations a model wrote as links or in groups, without the made-up URLs", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "add a README");
    await requestSummary(db, sid, "bob");
    const text =
      "Goal: a README [#[2](https://github.com/x/pulls)]. Done: nothing ([#2](https://example.com)). Watch out: [#9](https://example.com). See [#1, #2] and [#2-#3].";
    await writeSummaries(noteDeps(new ScriptedModel([say(text)])), sid);
    const [note] = await notes(sid);
    expect(note.payload.text).toBe("Goal: a README [#2]. Done: nothing ([#2]). Watch out:. See [#1], [#2] and [#2]-[#3].");
    expect(note.payload.droppedCitations).toEqual([9]);
  });

  it("covers only what happened while a returning driver was away", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "first thing");
    await driveSession(deps(db, new ScriptedModel([say("did the first thing")])), sid);
    const [left] = await passDriver(db, sid, "alice", "bob");
    await postMessage(db, sid, "bob", "second thing");
    await driveSession(deps(db, new ScriptedModel([say("did the second thing")])), sid);
    await passDriver(db, sid, "bob", "alice");

    const writer = new ScriptedModel([say("for bob"), say("for alice")]);
    expect(await writeSummaries(noteDeps(writer), sid)).toBe(2);
    const [, forAlice] = await notes(sid);
    expect(forAlice.payload).toMatchObject({ for: "alice", sinceSeq: left.seq });
    expect(forAlice.payload.facts.instructions).toEqual([{ seq: expect.any(Number), author: "bob", text: "second thing" }]);
    expect(promptOf(writer, 1)).toContain(`alice already knows everything up to #${left.seq}`);
  });

  it("skips the model when nothing has happened", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await passDriver(db, sid, "alice", "bob");
    const writer = new ScriptedModel([]);
    await writeSummaries(noteDeps(writer), sid);
    const [note] = await notes(sid);
    expect(note.payload.text).toMatch(/^Nothing has happened since the session started/);
    expect(writer.requests).toHaveLength(0);
  });

  it("records a failure instead of retrying forever, and you can ask again", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "do a thing");
    await requestSummary(db, sid, "bob");
    await writeSummaries(noteDeps(new ScriptedModel([async () => { throw new Error("overloaded"); }])), sid);
    const failed = (await log(sid)).find((e) => e.type === "summary_failed");
    expect(failed?.payload).toMatchObject({ for: "bob", error: "overloaded" });
    expect(await sessionsNeedingSummaries(db)).toEqual([]);
    expect((await requestSummary(db, sid, "bob")).existing).toBe(false);
  });
});

describe("handoff facts", () => {
  it("takes the facts from the log, not from the model", async () => {
    const remote = remoteRepo();
    const sid = await createSession(db, { title: "t", createdBy: "alice", repoUrl: remote });
    const run = (turns: ModelResponse[]) =>
      driveSession({ ...deps(db, new ScriptedModel(turns), { extraTools: gitTools }), credentialsKey: KEY, github: new FakeGitHub() }, sid);

    await postMessage(db, sid, "alice", "add a README and push it to a branch");
    await run([
      toolUse("write_file", { path: "README.md", contents: "# hi\n" }),
      toolUse("git_commit", { message: "Add README" }),
      toolUse("git_push", { branch: "readme" }),
      say("pushed"),
    ]);
    await passDriver(db, sid, "alice", "bob");
    await postMessage(db, sid, "bob", "fix the heading and ship it to main");
    await postMessage(db, sid, "carol", "maybe add a LICENSE too");
    await run([
      toolUse("write_file", { path: "README.md", contents: "# Hi\n" }),
      toolUse("git_commit", { message: "Fix heading" }),
      toolUse("git_push", { branch: "main" }), // waits for a second maintainer
    ]);
    await requestSummary(db, sid, "dave");
    // The model's prose says nothing useful; the facts don't depend on it.
    // (Bob's handoff note is written first, then Dave's.)
    await writeSummaries(noteDeps(new ScriptedModel([say("A note."), say("A note.")]), "notes-a"), sid);

    const dave = (await notes(sid)).find((n) => n.payload.for === "dave")!;
    expect(dave.payload.facts).toMatchObject({
      driver: "bob",
      agent: "waiting for an approval",
      handoffs: [{ from: "alice", to: "bob" }],
      commits: [
        { by: "alice", message: "Add README" },
        { by: "bob", message: "Fix heading" },
      ],
      pushes: [{ by: "alice", branch: "readme", approvedBy: null }],
      filesChanged: [{ path: "README.md", by: "bob" }],
      pendingApprovals: [{ tool: "git_push", requestedFor: "bob" }],
      pendingSuggestions: [{ author: "carol", text: "maybe add a LICENSE too" }],
      failures: [],
    });
    expect(dave.payload.facts.commits[0].sha).toMatch(/^[0-9a-f]{7,}$/);
  });
});
