import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { append, type SessionEvent } from "./events.js";

export async function createSession(db: Db, opts: { title: string; createdBy: string }): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO sessions (id, title, created_by) VALUES ($1, $2, $3)", [id, opts.title, opts.createdBy]);
  await append(db, id, [{ type: "session_created", actor: opts.createdBy, payload: { title: opts.title } }]);
  return id;
}

/**
 * A human steering the session. It never waits for the agent: the message
 * goes on the log and the agent picks it up at its next step boundary.
 */
export async function postMessage(db: Db, sessionId: string, userId: string, text: string): Promise<SessionEvent> {
  const [event] = await append(db, sessionId, [{ type: "user_message", actor: userId, payload: { text } }]);
  await db.query("UPDATE sessions SET status = 'pending' WHERE id = $1 AND status = 'idle'", [sessionId]);
  return event;
}

/** Sessions that have work no live worker is doing, e.g. after a crash. */
export async function sessionsNeedingWork(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id FROM sessions s
     LEFT JOIN session_leases l ON l.session_id = s.id AND l.expires_at > now()
     WHERE s.status IN ('pending', 'running') AND l.session_id IS NULL
     ORDER BY s.created_at`,
  );
  return rows.map((r) => r.id);
}
