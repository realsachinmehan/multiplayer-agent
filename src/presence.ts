import type { Db } from "./db.js";

export const PRESENCE_CHANNEL = "session_presence";

export async function join(db: Db, connectionId: string, sessionId: string, userId: string, ttlMs: number): Promise<void> {
  await db.query(
    `INSERT INTO presence (connection_id, session_id, user_id, expires_at)
     VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')`,
    [connectionId, sessionId, userId, ttlMs],
  );
  await db.query("SELECT pg_notify($1, $2)", [PRESENCE_CHANNEL, sessionId]);
}

/** Keeps a connection's row alive. Silent: nothing changed for watchers. */
export async function heartbeat(db: Db, connectionId: string, ttlMs: number): Promise<void> {
  await db.query("UPDATE presence SET expires_at = now() + $2 * interval '1 millisecond' WHERE connection_id = $1", [
    connectionId,
    ttlMs,
  ]);
}

export async function leave(db: Db, connectionId: string): Promise<void> {
  const { rows } = await db.query<{ session_id: string }>(
    "DELETE FROM presence WHERE connection_id = $1 RETURNING session_id",
    [connectionId],
  );
  for (const r of rows) await db.query("SELECT pg_notify($1, $2)", [PRESENCE_CHANNEL, r.session_id]);
}

/** Drops rows left behind by a server that died, and tells their sessions. */
export async function sweepExpired(db: Db): Promise<void> {
  const { rows } = await db.query<{ session_id: string }>(
    "DELETE FROM presence WHERE expires_at <= now() RETURNING session_id",
  );
  for (const id of new Set(rows.map((r) => r.session_id))) {
    await db.query("SELECT pg_notify($1, $2)", [PRESENCE_CHANNEL, id]);
  }
}

export type Watcher = { userId: string; connections: number };

export async function watchers(db: Db, sessionId: string): Promise<Watcher[]> {
  const { rows } = await db.query<{ user_id: string; n: string }>(
    `SELECT user_id, count(*) AS n FROM presence
     WHERE session_id = $1 AND expires_at > now()
     GROUP BY user_id ORDER BY user_id`,
    [sessionId],
  );
  return rows.map((r) => ({ userId: r.user_id, connections: Number(r.n) }));
}
