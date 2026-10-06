import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  claimDriver,
  CommandError,
  dismissSuggestion,
  passDriver,
  pause,
  postMessage,
  resume,
  withdraw,
} from "../src/commands.js";
import type { Db } from "../src/db.js";
import { readEvents, type SessionEvent } from "../src/events.js";
import { createSession } from "../src/sessions.js";
import { fold } from "../src/state.js";
import type { Tool } from "../src/tools.js";
import { driveSession } from "../src/worker.js";
import { deps, gate, say, ScriptedModel, testDb, toolUse } from "./helpers.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.end();
});

const log = (sid: string) => readEvents(db, sid);
const types = (events: SessionEvent[]) => events.map((e) => e.type);
const prompt = (m: ScriptedModel, i: number) => JSON.stringify(m.requests[i].messages);

async function rejects(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CommandError && e.status === status);
}

async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

async function present(sid: string, user: string) {
  await db.query(
    `INSERT INTO presence (connection_id, session_id, user_id, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now() + interval '1 minute')`,
    [sid, user],
  );
}

describe("driver and suggestions", () => {
  it("turns a non-driver's message into a suggestion the agent only sees once the driver accepts it", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const s = await postMessage(db, sid, "bob", "use a Map instead of an object");
    expect(s.type).toBe("suggestion");
    expect(fold(await log(sid)).next.kind).toBe("idle");

    await acceptSuggestion(db, sid, "alice", s.seq);
    const model = new ScriptedModel([say("switched to a Map")]);
    await driveSession(deps(db, model), sid);

    expect(prompt(model, 0)).toContain("[bob, accepted by alice] use a Map instead of an object");
    const reply = (await log(sid)).find((e) => e.type === "model_response")!;
    // Alice approved it, so the agent acts with her authority.
    expect(reply.onBehalfOf).toBe("alice");
  });

  it("applies exactly one of an accept and a dismiss that race on the same suggestion", async () => {
    for (let i = 0; i < 10; i++) {
      const sid = await createSession(db, { title: "t", createdBy: "alice" });
      const s = await postMessage(db, sid, "bob", "rename it");
      const results = await Promise.allSettled([
        acceptSuggestion(db, sid, "alice", s.seq),
        dismissSuggestion(db, sid, "alice", s.seq),
        acceptSuggestion(db, sid, "alice", s.seq),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const resolutions = (await log(sid)).filter(
        (e) => e.type === "suggestion_dismissed" || (e.type === "user_message" && e.payload.suggestionSeq === s.seq),
      );
      expect(resolutions).toHaveLength(1);
    }
  });

  it("only lets the driver accept, dismiss, pass the wheel or resume", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const s = await postMessage(db, sid, "bob", "idea");
    await rejects(acceptSuggestion(db, sid, "bob", s.seq), 403);
    await rejects(dismissSuggestion(db, sid, "carol", s.seq), 403);
    await rejects(passDriver(db, sid, "bob", "bob"), 403);
    await pause(db, sid, "bob");
    await rejects(resume(db, sid, "bob"), 403);
    await resume(db, sid, "alice");
  });
});

describe("handoff", () => {
  it("withdraws the old driver's unread instructions when the wheel changes hands", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const a = await postMessage(db, sid, "alice", "delete the legacy folder");
    const pending = await postMessage(db, sid, "carol", "add tests first");
    await passDriver(db, sid, "alice", "bob");

    const state = fold(await log(sid));
    expect(state.driver).toBe("bob");
    expect(state.queued).toEqual([]);
    // Suggestions are addressed to whoever drives, so they carry over.
    expect(state.suggestions.map((s) => s.seq)).toEqual([pending.seq]);
    expect((await log(sid)).find((e) => e.type === "withdrawn")!.payload).toEqual({
      targetSeq: a.seq,
      reason: "driver_changed",
    });

    await postMessage(db, sid, "bob", "keep the legacy folder, just rename it");
    const model = new ScriptedModel([say("renamed it")]);
    await driveSession(deps(db, model), sid);
    expect(prompt(model, 0)).not.toContain("delete the legacy folder");
    expect(prompt(model, 0)).toContain("[bob] keep the legacy folder");
  });

  it("discards a model turn that was planned before a handoff", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "drop the users table");
    const thinking = gate();
    const called = gate();
    const model = new ScriptedModel([
      async () => {
        called.open();
        await thinking.promise;
        return toolUse("write_file", { path: "migration.sql", contents: "DROP TABLE users;" });
      },
    ]);
    const run = driveSession(deps(db, model), sid);
    await called.promise;
    await passDriver(db, sid, "alice", "bob");
    thinking.open();
    expect(await run).toBe("idle");

    const events = await log(sid);
    expect(types(events)).not.toContain("model_response");
    expect(types(events)).not.toContain("tool_started");
    expect(model.requests).toHaveLength(1);
  });

  it("never lets an instruction race past a handoff", async () => {
    // Alice sends an instruction at the same moment she hands over. Either it
    // lands first and the handoff withdraws it, or it lands after and is
    // only a suggestion. It never reaches the agent with her authority.
    for (let i = 0; i < 20; i++) {
      const sid = await createSession(db, { title: "t", createdBy: "alice" });
      await Promise.all([postMessage(db, sid, "alice", "force push main"), passDriver(db, sid, "alice", "bob")]);
      const state = fold(await log(sid));
      expect(state.driver).toBe("bob");
      expect(state.queued).toEqual([]);
      expect(state.next.kind).toBe("idle");
    }
  });

  it("lets someone claim the wheel only when the driver has left, and only one claimer wins", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await present(sid, "alice");
    await rejects(claimDriver(db, sid, "bob"), 409);

    await db.query("DELETE FROM presence WHERE user_id = 'alice'");
    await present(sid, "bob");
    await present(sid, "carol");
    const results = await Promise.allSettled([claimDriver(db, sid, "bob"), claimDriver(db, sid, "carol")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const changes = (await log(sid)).filter((e) => e.type === "driver_changed");
    expect(changes).toHaveLength(1);
    expect(changes[0].payload).toMatchObject({ from: "alice", reason: "claimed" });
  });
});

describe("pause", () => {
  function slowTool(name: string, release: Promise<void>, started: () => void): Tool {
    return {
      definition: { name, description: name, input_schema: { type: "object", properties: {} } },
      idempotent: false,
      async run() {
        started();
        await release;
        return `${name} done`;
      },
    };
  }

  it("lets a running tool finish, cancels the rest, and waits for the driver to resume", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "migrate and then deploy");
    const release = gate();
    const started = gate();
    const both = toolUse("migrate", {});
    both.content.push(toolUse("deploy", {}).content[0]);
    const model = new ScriptedModel([both, say("the migration ran; deploy was cancelled, so I stopped")]);
    const d = deps(db, model, { extraTools: [slowTool("migrate", release.promise, started.open), slowTool("deploy", release.promise, () => {})] });

    const run = driveSession(d, sid);
    await started.promise;
    await pause(db, sid, "bob");
    release.open();
    expect(await run).toBe("idle");

    let events = await log(sid);
    expect(events.filter((e) => e.type === "tool_finished").map((e) => e.payload)).toEqual([
      { toolUseId: (both.content[0] as { id: string }).id, output: "migrate done", isError: false },
    ]);
    expect(events.filter((e) => e.type === "tool_started")).toHaveLength(1);
    expect(model.requests).toHaveLength(1);

    await resume(db, sid, "alice");
    await driveSession(d, sid);
    expect(model.requests).toHaveLength(2);
    const results = prompt(model, 1);
    expect(results).toContain("migrate done");
    expect(results).toContain("not run: bob paused the session before this started");
    events = await log(sid);
    expect(types(events).filter((t) => t === "tool_started")).toHaveLength(1);
  });

  it("throws away a model turn that was in flight when someone paused", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "rewrite the auth module");
    const thinking = gate();
    const called = gate();
    const model = new ScriptedModel([
      async () => {
        called.open();
        await thinking.promise;
        return toolUse("write_file", { path: "auth.ts", contents: "" });
      },
      say("ok, rewriting it carefully"),
    ]);
    const run = driveSession(deps(db, model), sid);
    await called.promise;
    await pause(db, sid, "carol");
    thinking.open();
    expect(await run).toBe("idle");
    expect(types(await log(sid))).not.toContain("model_response");

    // Resuming asks the model again from the same instruction.
    await resume(db, sid, "alice");
    await driveSession(deps(db, model), sid);
    expect(model.requests).toHaveLength(2);
    expect(prompt(model, 1)).toContain("rewrite the auth module");
  });

  it("queues instructions sent while paused and runs them on resume", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await pause(db, sid, "alice");
    await postMessage(db, sid, "alice", "add a README");
    const model = new ScriptedModel([say("added")]);
    expect(await driveSession(deps(db, model), sid)).toBe("idle");
    expect(model.requests).toHaveLength(0);

    await resume(db, sid, "alice");
    await driveSession(deps(db, model), sid);
    expect(prompt(model, 0)).toContain("add a README");
  });
});

describe("withdraw", () => {
  it("lets the author take back an instruction until the agent has read it", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const first = await postMessage(db, sid, "alice", "bump every dependency");
    await rejects(withdraw(db, sid, "bob", first.seq), 403);
    await withdraw(db, sid, "alice", first.seq);
    await rejects(withdraw(db, sid, "alice", first.seq), 409);
    expect(fold(await log(sid)).next.kind).toBe("idle");

    const second = await postMessage(db, sid, "alice", "bump only lodash");
    await driveSession(deps(db, new ScriptedModel([say("bumped lodash")])), sid);
    await rejects(withdraw(db, sid, "alice", second.seq), 409);
  });

  it("discards a model turn whose instruction was withdrawn while the model was thinking", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const m = await postMessage(db, sid, "alice", "delete all the tests");
    const thinking = gate();
    const called = gate();
    const model = new ScriptedModel([
      async () => {
        called.open();
        await thinking.promise;
        return say("deleting the tests");
      },
    ]);
    const run = driveSession(deps(db, model), sid);
    await called.promise;
    await withdraw(db, sid, "alice", m.seq);
    thinking.open();
    expect(await run).toBe("idle");
    expect(types(await log(sid))).toEqual(["session_created", "user_message", "withdrawn"]);
  });

  it("lets a suggester take back a pending suggestion", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const s = await postMessage(db, sid, "bob", "switch to tabs");
    await withdraw(db, sid, "bob", s.seq);
    await rejects(acceptSuggestion(db, sid, "alice", s.seq), 409);
  });
});

describe("worker under concurrent steering", () => {
  it("keeps the agent's view consistent while three people pause, resume, suggest and hand off at random", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const users = ["alice", "bob", "carol"];
    // A model that keeps calling a cheap tool until told otherwise.
    const turns = Array.from({ length: 1000 }, (_, i) => (i % 2 ? say(`step ${i}`) : toolUse("list_files", { path: "." })));
    const model = new ScriptedModel(turns);
    const d = deps(db, model, { maxSteps: 200, leaseTtlMs: 10_000 });
    await postMessage(db, sid, "alice", "start");

    let stop = false;
    const agent = (async () => {
      while (!stop) {
        await driveSession(d, sid);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const rnd = (n: number) => Math.floor(Math.random() * n);
    for (let i = 0; i < 60; i++) {
      const user = users[rnd(3)];
      const state = fold(await log(sid));
      const actions = [
        () => postMessage(db, sid, user, `note ${i}`),
        () => pause(db, sid, user),
        () => resume(db, sid, state.driver!),
        () => passDriver(db, sid, state.driver!, users[rnd(3)]),
        () => (state.suggestions[0] ? acceptSuggestion(db, sid, state.driver!, state.suggestions[0].seq) : postMessage(db, sid, user, "x")),
      ];
      await actions[rnd(actions.length)]().catch((e) => {
        if (!(e instanceof CommandError)) throw e;
      });
    }
    stop = true;
    await agent;

    const events = await log(sid);
    // Every instruction the model read came from whoever was driving when it
    // was sent, and no tool ever started while the session was paused.
    let driver = "alice";
    let paused = false;
    for (const e of events) {
      if (e.type === "driver_changed") driver = e.payload.to;
      if (e.type === "paused") paused = true;
      if (e.type === "resumed") paused = false;
      if (e.type === "user_message") expect(e.actor).toBe(driver);
      if (e.type === "tool_started") expect(paused).toBe(false);
    }
    // And the folded conversation is still one the API would accept: every
    // tool_use is answered in the very next user turn.
    const msgs = fold(events).messages;
    msgs.forEach((m, i) => {
      if (m.role !== "assistant") return;
      const uses = (m.content as any[]).filter((b) => b.type === "tool_use").map((b) => b.id);
      if (!uses.length || i === msgs.length - 1) return;
      const answered = (msgs[i + 1].content as any[]).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
      expect(answered.sort()).toEqual(uses.sort());
    });

    // After all that, the session still works: the driver can resume and
    // the agent picks up a fresh instruction.
    const after = fold(events);
    if (after.paused) await resume(db, sid, after.driver!);
    await postMessage(db, sid, after.driver!, "wrap up");
    const before = model.requests.length;
    await driveSession(d, sid);
    expect(model.requests.length).toBeGreaterThan(before);
    expect(prompt(model, model.requests.length - 1)).toContain("wrap up");
  });
});
