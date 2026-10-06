import type Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { withTx, type Db } from "./db.js";

export type EventBody =
  | { type: "session_created"; payload: { title: string } }
  // An instruction the agent will act on. Only the driver's messages are
  // instructions; an accepted suggestion becomes one in the driver's name.
  | { type: "user_message"; payload: { text: string; suggestedBy?: string; suggestionSeq?: number } }
  // A non-driver's message. Everyone sees it; the agent doesn't, unless the
  // driver accepts it.
  | { type: "suggestion"; payload: { text: string } }
  | { type: "suggestion_dismissed"; payload: { suggestionSeq: number } }
  // Takes back an instruction the agent hasn't read yet, or a pending suggestion.
  | { type: "withdrawn"; payload: { targetSeq: number; reason: "author" | "driver_changed" } }
  | { type: "driver_changed"; payload: { from: string; to: string; reason: "passed" | "claimed" } }
  | { type: "paused"; payload: Record<string, never> }
  | { type: "resumed"; payload: Record<string, never> }
  | {
      type: "model_response";
      payload: {
        // Stored exactly as the API returned it and replayed unchanged, so the
        // conversation history stays append-only.
        content: Anthropic.Beta.BetaContentBlock[];
        stopReason: string | null;
        // Highest seq the model saw in its prompt. Messages with a higher seq
        // that landed while the model was thinking are queued for the next step.
        basedOnSeq: number;
      };
    }
  | { type: "tool_started"; payload: { toolUseId: string; name: string; input: unknown } }
  | { type: "tool_finished"; payload: { toolUseId: string; output: string; isError: boolean } };

export type EventType = EventBody["type"];

export type SessionEvent = EventBody & {
  sessionId: string;
  seq: number;
  actor: string;
  onBehalfOf: string | null;
  createdAt: Date;
};

export const AGENT = "agent";
export const EVENTS_CHANNEL = "session_events";

/** Events that change what the agent should be doing right now. */
export const CONTROL_EVENTS: ReadonlySet<EventType> = new Set(["paused", "resumed", "driver_changed", "withdrawn"]);

/** Thrown when an agent append carries a stale fencing epoch. */
export class LeaseLostError extends Error {
  constructor(sessionId: string, epoch: number) {
    super(`lease on session ${sessionId} no longer held at epoch ${epoch}`);
  }
}

export type Fence = { epoch: number };

export type AppendInput = EventBody & { actor: string; onBehalfOf?: string | null };

/** The session row as a command sees it, locked for the whole transaction. */
export type SessionRow = {
  id: string;
  createdBy: string;
  lastSeq: number;
  driver: string;
  paused: boolean;
  controlSeq: number;
};

export type AppendOpts = {
  fence?: Fence;
  // Runs under the session's row lock before anything is written. Throwing
  // aborts the append, so the check and the write see the same state.
  check?: (c: pg.PoolClient, s: SessionRow) => Promise<void> | void;
};

/**
 * Appends events to a session in one transaction and returns them with their
 * sequence numbers. Seqs are dense and strictly increasing per session.
 *
 * Every append takes the session row lock, so appends to one session are
 * serialized and a check sees exactly the state the write applies to.
 * Agent writes also pass a fence: the lease row is locked too, so a lease
 * takeover either happens before (and this append fails) or after it commits.
 */
export async function append(
  db: Db,
  sessionId: string,
  inputs: AppendInput[],
  opts: AppendOpts = {},
): Promise<SessionEvent[]> {
  return withTx(db, async (c) => {
    if (opts.fence) await checkFence(c, sessionId, opts.fence);
    const s = await lockSession(c, sessionId);
    await opts.check?.(c, s);
    return insert(c, s, inputs);
  });
}

/**
 * Like append, but the events to write are decided under the lock from the
 * state at that moment. This is how human commands run: two people acting
 * at once are serialized, and the second one decides against the first
 * one's result instead of a stale read.
 */
export async function appendDecided(
  db: Db,
  sessionId: string,
  decide: (c: pg.PoolClient, s: SessionRow) => Promise<AppendInput[]>,
): Promise<SessionEvent[]> {
  return withTx(db, async (c) => {
    const s = await lockSession(c, sessionId);
    const inputs = await decide(c, s);
    return inputs.length ? insert(c, s, inputs) : [];
  });
}

async function lockSession(c: pg.PoolClient, sessionId: string): Promise<SessionRow> {
  const { rows } = await c.query(
    "SELECT id, created_by, last_seq, driver, paused, control_seq FROM sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  if (rows.length === 0) throw new Error(`no session ${sessionId}`);
  const r = rows[0];
  return {
    id: r.id,
    createdBy: r.created_by,
    lastSeq: Number(r.last_seq),
    driver: r.driver ?? r.created_by,
    paused: r.paused,
    controlSeq: Number(r.control_seq),
  };
}

async function insert(c: pg.PoolClient, s: SessionRow, inputs: AppendInput[]): Promise<SessionEvent[]> {
  let { lastSeq: seq, driver, paused, controlSeq } = s;
  const out: SessionEvent[] = [];
  for (const e of inputs) {
    seq += 1;
    const onBehalfOf = e.onBehalfOf ?? (e.actor === AGENT ? null : e.actor);
    const res = await c.query<{ created_at: Date }>(
      `INSERT INTO events (session_id, seq, type, actor, on_behalf_of, payload)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
      [s.id, seq, e.type, e.actor, onBehalfOf, JSON.stringify(e.payload)],
    );
    out.push({ ...e, sessionId: s.id, seq, onBehalfOf, createdAt: res.rows[0].created_at } as SessionEvent);
    if (e.type === "driver_changed") driver = e.payload.to;
    if (e.type === "paused") paused = true;
    if (e.type === "resumed") paused = false;
    if (CONTROL_EVENTS.has(e.type)) controlSeq = seq;
  }
  await c.query("UPDATE sessions SET last_seq = $2, driver = $3, paused = $4, control_seq = $5 WHERE id = $1", [
    s.id,
    seq,
    driver,
    paused,
    controlSeq,
  ]);
  // Delivered on commit. It carries no data: listeners re-read the log, so
  // a lost notification costs latency, never correctness.
  await c.query("SELECT pg_notify($1, $2)", [EVENTS_CHANNEL, s.id]);
  return out;
}

async function checkFence(c: pg.PoolClient, sessionId: string, fence: Fence): Promise<void> {
  const { rows } = await c.query<{ epoch: string }>(
    "SELECT epoch FROM session_leases WHERE session_id = $1 AND expires_at > now() FOR SHARE",
    [sessionId],
  );
  if (rows.length === 0 || Number(rows[0].epoch) !== fence.epoch) {
    throw new LeaseLostError(sessionId, fence.epoch);
  }
}

export async function readEvents(db: Db | pg.PoolClient, sessionId: string, afterSeq = 0, limit?: number): Promise<SessionEvent[]> {
  const { rows } = await db.query(
    `SELECT session_id, seq, type, actor, on_behalf_of, payload, created_at
     FROM events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [sessionId, afterSeq, limit ?? null],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    seq: Number(r.seq),
    type: r.type,
    actor: r.actor,
    onBehalfOf: r.on_behalf_of,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}
