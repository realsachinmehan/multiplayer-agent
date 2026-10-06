import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { startServer, type RunningServer } from "../src/server.js";
import { postMessage } from "../src/commands.js";
import { createSession } from "../src/sessions.js";
import { driveSession } from "../src/worker.js";
import { deps, say, ScriptedModel, testDb, toolUse } from "./helpers.js";
import { SseClient } from "./sse.js";

let db: Db;
let server: RunningServer;
const clients: SseClient[] = [];

beforeEach(async () => {
  db = await testDb();
  server = await startServer(db, { heartbeatMs: 200 });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
  await db.end();
});

function watch(srv: RunningServer, sessionId: string, user: string, opts: { after?: number; lastEventId?: number } = {}) {
  const headers: Record<string, string> = opts.lastEventId != null ? { "last-event-id": String(opts.lastEventId) } : {};
  const c = new SseClient(`${srv.url}/sessions/${sessionId}/stream?as=${user}&after=${opts.after ?? 0}`, headers);
  clients.push(c);
  return c;
}

async function post(srv: RunningServer, sessionId: string, user: string | null, text: string) {
  const q = user ? `?as=${user}` : "";
  return fetch(`${srv.url}/sessions/${sessionId}/messages${q}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("event stream", () => {
  it("replays the whole log to a late joiner, then continues live with no gaps or repeats", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    for (let i = 0; i < 5; i++) await postMessage(db, sid, "alice", `earlier ${i}`);

    const bob = watch(server, sid, "bob");
    await bob.until((c) => c.seqs().length === 6);
    for (let i = 0; i < 3; i++) await post(server, sid, "alice", `live ${i}`);
    await bob.until((c) => c.seqs().length === 9);

    expect(bob.seqs()).toEqual(range(1, 9));
    expect(bob.messages.filter((m) => m.event === "session_event").map((m) => m.id)).toEqual(range(1, 9).map(String));
  });

  it("resumes after Last-Event-ID when a client reconnects", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    for (let i = 0; i < 6; i++) await postMessage(db, sid, "alice", `m${i}`);

    const c = watch(server, sid, "alice", { lastEventId: 4 });
    await c.until((c) => c.seqs().length === 3);
    expect(c.seqs()).toEqual([5, 6, 7]);
  });

  it("gives every watcher the same order while several people post at once", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const watchers = ["alice", "bob", "carol"].map((u) => watch(server, sid, u));
    await Promise.all(watchers.map((w) => w.until((c) => c.seqs().length === 1)));

    const res = await Promise.all(range(1, 30).map((i) => post(server, sid, ["alice", "bob", "carol"][i % 3], `msg ${i}`)));
    expect(res.every((r) => r.status === 201)).toBe(true);

    for (const w of watchers) {
      await w.until((c) => c.seqs().length === 31);
      expect(w.seqs()).toEqual(range(1, 31));
    }
    const order = (w: SseClient) => w.events().map((e) => e.payload.text ?? e.payload.title);
    expect(order(watchers[1])).toEqual(order(watchers[0]));
    expect(order(watchers[2])).toEqual(order(watchers[0]));
  });

  it("reaches watchers connected to a different server process", async () => {
    const other = await startServer(db, { heartbeatMs: 200 });
    try {
      const sid = await createSession(db, { title: "t", createdBy: "alice" });
      const bobOnB = watch(other, sid, "bob");
      await bobOnB.until((c) => c.seqs().length === 1);

      await post(server, sid, "alice", "sent through server A");
      await bobOnB.until((c) => c.seqs().length === 2);
      expect(bobOnB.events()[1]).toMatchObject({ actor: "alice", payload: { text: "sent through server A" } });
    } finally {
      for (const c of clients.splice(0)) c.close();
      await other.close();
    }
  });

  it("streams a live agent run step by step", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const bob = watch(server, sid, "bob");
    await bob.until((c) => c.seqs().length === 1);

    await post(server, sid, "alice", "create notes.md");
    const model = new ScriptedModel([toolUse("write_file", { path: "notes.md", contents: "# notes" }), say("created it")]);
    await driveSession(deps(db, model), sid);

    await bob.until((c) => c.seqs().length === 6);
    expect(bob.events().map((e) => [e.type, e.onBehalfOf])).toEqual([
      ["session_created", "alice"],
      ["user_message", "alice"],
      ["model_response", "alice"],
      ["tool_started", "alice"],
      ["tool_finished", "alice"],
      ["model_response", "alice"],
    ]);
  });
});

describe("presence", () => {
  it("shows who is watching and updates when people leave", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const alice = watch(server, sid, "alice");
    await alice.until((c) => c.latestPresence()?.join() === "alice");

    const bob = watch(server, sid, "bob");
    await alice.until((c) => c.latestPresence()?.join() === "alice,bob");
    await bob.until((c) => c.latestPresence()?.join() === "alice,bob");

    bob.close();
    await alice.until((c) => c.latestPresence()?.join() === "alice");
  });

  it("keeps someone present while any of their tabs is open", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const tab1 = watch(server, sid, "alice");
    const tab2 = watch(server, sid, "alice");
    const bob = watch(server, sid, "bob");
    await bob.until((c) => c.messages.some((m) => m.event === "presence" && m.data[0]?.connections === 2));

    tab1.close();
    await bob.until((c) => {
      const p = c.messages.filter((m) => m.event === "presence").at(-1)!.data;
      return p.length === 2 && p[0].connections === 1;
    });
    expect(bob.latestPresence()).toEqual(["alice", "bob"]);
    tab2.close();
  });

  it("drops watchers whose server died without saying goodbye", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    const alice = watch(server, sid, "alice");
    await alice.until((c) => c.latestPresence()?.join() === "alice");

    // A row from a server that crashed: nobody will heartbeat or delete it.
    await db.query(
      `INSERT INTO presence (connection_id, session_id, user_id, expires_at)
       VALUES (gen_random_uuid(), $1, 'ghost', now() + interval '300 milliseconds')`,
      [sid],
    );
    await db.query("SELECT pg_notify('session_presence', $1)", [sid]);
    await alice.until((c) => c.latestPresence()?.join() === "alice,ghost");
    await alice.until((c) => c.latestPresence()?.join() === "alice", 3000);
  });
});

describe("http api", () => {
  it("requires a name to post and attributes the message to it", async () => {
    const sid = await createSession(db, { title: "t", createdBy: "alice" });
    expect((await post(server, sid, null, "who am I")).status).toBe(401);
    const res = await post(server, sid, "bob", "hello");
    expect(res.status).toBe(201);
    const events = await (await fetch(`${server.url}/sessions/${sid}/events?after=1`)).json();
    // Bob isn't driving, so his message is a suggestion for Alice.
    expect(events).toMatchObject([{ seq: 2, actor: "bob", type: "suggestion", payload: { text: "hello" } }]);
  });

  it("404s on a session that doesn't exist", async () => {
    const res = await fetch(`${server.url}/sessions/00000000-0000-0000-0000-000000000000/stream?as=alice`);
    expect(res.status).toBe(404);
  });

  it("creates a session over HTTP and serves the client", async () => {
    const res = await fetch(`${server.url}/sessions?as=alice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "fix the flaky test" }),
    });
    expect(res.status).toBe(201);
    const list = await (await fetch(`${server.url}/sessions`)).json();
    expect(list).toMatchObject([{ title: "fix the flaky test", created_by: "alice" }]);
    expect(await (await fetch(server.url)).text()).toContain("Multiplayer Agent");
  });
});
