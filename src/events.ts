import type Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { withTx, type Db } from "./db.js";

export type EventBody =
  | { type: "session_created"; payload: { title: string } }
  | { type: "user_message"; payload: { text: string } }
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

/** Thrown when an agent append carries a stale fencing epoch. */
export class LeaseLostError extends Error {
  constructor(sessionId: string, epoch: number) {
    super(`lease on session ${sessionId} no longer held at epoch ${epoch}`);
  }
}

export type Fence = { epoch: number };

export type AppendInput = EventBody & { actor: string; onBehalfOf?: string | null };

/**
 * Appends events to a session in one transaction and returns them with their
 * sequence numbers. Seqs are dense and strictly increasing per session.
 *
 * Agent writes pass a fence. The lease row is locked for the duration of the
 * transaction, so a lease takeover either happens before (and this append
 * fails) or waits until after it commits.
 */
export async function append(db: Db, sessionId: string, inputs: AppendInput[], fence?: Fence): Promise<SessionEvent[]> {
  return withTx(db, async (c) => {
    if (fence) await checkFence(c, sessionId, fence);

    const { rows } = await c.query<{ last_seq: string }>(
      "UPDATE sessions SET last_seq = last_seq + $2 WHERE id = $1 RETURNING last_seq",
      [sessionId, inputs.length],
    );
    if (rows.length === 0) throw new Error(`no session ${sessionId}`);
    let seq = Number(rows[0].last_seq) - inputs.length;

    const out: SessionEvent[] = [];
    for (const e of inputs) {
      seq += 1;
      const onBehalfOf = e.onBehalfOf ?? (e.actor === AGENT ? null : e.actor);
      const res = await c.query<{ created_at: Date }>(
        `INSERT INTO events (session_id, seq, type, actor, on_behalf_of, payload)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
        [sessionId, seq, e.type, e.actor, onBehalfOf, JSON.stringify(e.payload)],
      );
      out.push({ ...e, sessionId, seq, onBehalfOf, createdAt: res.rows[0].created_at } as SessionEvent);
    }
    await c.query("SELECT pg_notify('session_events', $1)", [sessionId]);
    return out;
  });
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

export async function readEvents(db: Db, sessionId: string, afterSeq = 0): Promise<SessionEvent[]> {
  const { rows } = await db.query(
    `SELECT session_id, seq, type, actor, on_behalf_of, payload, created_at
     FROM events WHERE session_id = $1 AND seq > $2 ORDER BY seq`,
    [sessionId, afterSeq],
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
