import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { AGENT, append, LeaseLostError, readEvents, type SessionEvent } from "../src/events.js";
import { acquireLease } from "../src/lease.js";
import { createSession, postMessage, sessionsNeedingWork } from "../src/sessions.js";
import { fold } from "../src/state.js";
import type { Tool } from "../src/tools.js";
import { driveSession } from "../src/worker.js";
import { deps, expireLease, gate, say, ScriptedModel, testDb, toolUse } from "./helpers.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.end();
});

const types = (events: SessionEvent[]) => events.map((e) => e.type);

async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

describe("agent loop", () => {
  it("runs tools until the model is done and attributes each step to the steerer", async () => {
    const sid = await createSession(db, { title: "hello", createdBy: "alice" });
    await postMessage(db, sid, "alice", "create hello.txt");
    const model = new ScriptedModel([toolUse("write_file", { path: "hello.txt", contents: "hi" }), say("done")]);
    const d = deps(db, model);

    expect(await driveSession(d, sid)).toBe("idle");

    const events = await readEvents(db, sid);
    expect(types(events)).toEqual([
      "session_created",
      "user_message",
      "model_response",
      "tool_started",
      "tool_finished",
      "model_response",
    ]);
    for (const e of events.filter((e) => e.actor === AGENT)) expect(e.onBehalfOf).toBe("alice");
    expect(readFileSync(join(d.workspaceRoot, sid, "hello.txt"), "utf8")).toBe("hi");

    // The second call sees the tool result right after the tool_use turn.
    const second = model.requests[1].messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[2].content).toMatchObject([{ type: "tool_result", content: "wrote 2 bytes to hello.txt" }]);
  });

  it("queues a message sent while the model is mid-call instead of losing it", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "rename foo to bar");
    const model = new ScriptedModel([
      async () => {
        // Bob speaks up while the model is still thinking about Alice's ask.
        await postMessage(db, sid, "bob", "actually call it baz");
        return say("renaming foo to bar");
      },
      say("switching to baz"),
    ]);

    expect(await driveSession(deps(db, model), sid)).toBe("idle");

    const [first, second] = model.requests;
    expect(JSON.stringify(first.messages)).not.toContain("baz");
    expect(second.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "[bob] actually call it baz" }],
    });

    // In the log Bob's message precedes the first reply, but the folded
    // conversation places it after, where the model actually read it.
    const state = fold(await readEvents(db, sid));
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const responses = (await readEvents(db, sid)).filter((e) => e.type === "model_response");
    expect(responses.map((e) => e.onBehalfOf)).toEqual(["alice", "bob"]);
  });

  it("does not go idle when a message lands between the last read and the idle check", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "hi");
    const model = new ScriptedModel([say("hello"), say("hello bob")]);
    const d = deps(db, model);
    // Slip Bob's message in right after the model's reply is appended, before
    // the worker's next read decides it is idle.
    const realNext = model.next.bind(model);
    let injected = false;
    model.next = async (req) => {
      const res = await realNext(req);
      if (!injected) {
        injected = true;
        setImmediate(() => void postMessage(db, sid, "bob", "and me?"));
      }
      return res;
    };

    expect(await driveSession(d, sid)).toBe("idle");
    await waitFor(async () => (await readEvents(db, sid)).some((e) => e.actor === "bob"));
    // Either the same run answered Bob, or the session is pending for the next worker.
    const state = fold(await readEvents(db, sid));
    const { rows } = await db.query("SELECT status FROM sessions WHERE id = $1", [sid]);
    expect(state.next.kind === "idle" || rows[0].status === "pending").toBe(true);
  });
});

describe("crash recovery", () => {
  function hangingTool(name: string, idempotent: boolean, release: Promise<void>, calls: { n: number }): Tool {
    return {
      definition: { name, description: name, input_schema: { type: "object", properties: {} } },
      idempotent,
      async run() {
        calls.n++;
        if (calls.n === 1) await release; // the first worker gets stuck here
        return `${name} ok`;
      },
    };
  }

  async function startedThenCrash(name: string, idempotent: boolean) {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", `run ${name}`);
    const release = gate();
    const calls = { n: 0 };
    const tool = hangingTool(name, idempotent, release.promise, calls);
    const model = new ScriptedModel([toolUse(name, {}), say("finished")]);

    // Worker A starts the tool and hangs, as if its process froze.
    const a = driveSession(deps(db, model, { extraTools: [tool], workerId: "worker-a" }), sid);
    await waitFor(async () => types(await readEvents(db, sid)).includes("tool_started"));
    await expireLease(db, sid);
    expect(await sessionsNeedingWork(db)).toEqual([sid]);

    // Worker B picks the session up from the log alone.
    expect(await driveSession(deps(db, model, { extraTools: [tool], workerId: "worker-b" }), sid)).toBe("idle");

    // A wakes up and tries to record its result. The fence rejects it.
    release.open();
    await expect(a).rejects.toBeInstanceOf(LeaseLostError);
    return { sid, calls, model };
  }

  it("re-runs an idempotent tool that a dead worker had started", async () => {
    const { sid, calls } = await startedThenCrash("read_config", true);
    expect(calls.n).toBe(2);
    const finished = (await readEvents(db, sid)).filter((e) => e.type === "tool_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0].payload).toMatchObject({ output: "read_config ok", isError: false });
  });

  it("never re-runs a non-idempotent tool and tells the model the outcome is unknown", async () => {
    const { sid, calls, model } = await startedThenCrash("deploy", false);
    expect(calls.n).toBe(1);
    const events = await readEvents(db, sid);
    expect(types(events).filter((t) => t === "tool_started")).toHaveLength(1);
    const finished = events.filter((e) => e.type === "tool_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0].payload).toMatchObject({ isError: true });
    expect(JSON.stringify(model.requests[1].messages)).toContain("may or may not have taken effect");
  });
});

describe("event log", () => {
  it("gives concurrent appends dense, unique sequence numbers", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const sent = await Promise.all(
      Array.from({ length: 50 }, (_, i) => postMessage(db, sid, `user${i % 5}`, `msg ${i}`)),
    );
    expect(sent.map((e) => e.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
    expect((await readEvents(db, sid)).map((e) => e.seq)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
  });

  it("rejects agent writes from a worker whose lease was taken over", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const a = await acquireLease(db, sid, "worker-a", 5_000);
    expect(await acquireLease(db, sid, "worker-b", 5_000)).toBeNull();
    await expireLease(db, sid);
    const b = await acquireLease(db, sid, "worker-b", 5_000);
    expect(b!.epoch).toBe(a!.epoch + 1);

    const write = { type: "user_message" as const, actor: AGENT, payload: { text: "x" } };
    await expect(append(db, sid, [write], a!)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(append(db, sid, [write], b!)).resolves.toHaveLength(1);
  });

  it("lets a late joiner rebuild exactly the conversation the model saw", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "list files");
    const model = new ScriptedModel([toolUse("list_files", { path: "." }), say("empty repo")]);
    await driveSession(deps(db, model), sid);

    const replayed = fold(await readEvents(db, sid)).messages;
    const last = model.requests.at(-1)!.messages;
    expect(replayed.slice(0, last.length)).toEqual(last);
    expect(replayed).toHaveLength(last.length + 1);
  });

  it("never runs a tool call from a turn that was cut off", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "write a big file");
    const truncated = { ...toolUse("write_file", { path: "big.txt" }), stopReason: "max_tokens" };
    const model = new ScriptedModel([truncated, say("I'll write it in parts")]);
    await driveSession(deps(db, model), sid);

    expect(types(await readEvents(db, sid))).not.toContain("tool_started");
    expect(model.requests[1].messages.at(-1)!.content).toMatchObject([
      { type: "tool_result", is_error: true, content: "not run: your response was cut off" },
    ]);
  });

  it("refuses paths outside the session workspace", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    await postMessage(db, sid, "alice", "read secrets");
    const model = new ScriptedModel([toolUse("read_file", { path: "../../etc/passwd" }), say("ok")]);
    const d = deps(db, model);
    await driveSession(d, sid);
    const finished = (await readEvents(db, sid)).find((e) => e.type === "tool_finished")!;
    expect(finished.payload).toMatchObject({ isError: true });
    expect(existsSync(join(d.workspaceRoot, sid))).toBe(true);
  });
});
