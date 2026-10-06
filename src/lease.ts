import type { Db } from "./db.js";
import type { Fence } from "./events.js";

export type Lease = Fence & { sessionId: string; workerId: string };

/**
 * Takes the session's lease if it is free, expired, or already ours. Every
 * change of holder bumps the epoch, which invalidates the previous holder's
 * fence. Returns null if another worker holds a live lease.
 */
export async function acquireLease(db: Db, sessionId: string, workerId: string, ttlMs: number): Promise<Lease | null> {
  const { rows } = await db.query<{ epoch: string }>(
    `INSERT INTO session_leases (session_id, worker_id, epoch, expires_at)
     VALUES ($1, $2, 1, now() + $3 * interval '1 millisecond')
     ON CONFLICT (session_id) DO UPDATE
       SET worker_id = EXCLUDED.worker_id,
           epoch = CASE WHEN session_leases.worker_id = EXCLUDED.worker_id
                         AND session_leases.expires_at > now()
                        THEN session_leases.epoch
                        ELSE session_leases.epoch + 1 END,
           expires_at = EXCLUDED.expires_at
       WHERE session_leases.expires_at <= now() OR session_leases.worker_id = EXCLUDED.worker_id
     RETURNING epoch`,
    [sessionId, workerId, ttlMs],
  );
  return rows.length ? { sessionId, workerId, epoch: Number(rows[0].epoch) } : null;
}

/** Extends a lease we still hold. Returns false if it was lost. */
export async function renewLease(db: Db, lease: Lease, ttlMs: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE session_leases SET expires_at = now() + $4 * interval '1 millisecond'
     WHERE session_id = $1 AND worker_id = $2 AND epoch = $3 AND expires_at > now()`,
    [lease.sessionId, lease.workerId, lease.epoch, ttlMs],
  );
  return rowCount === 1;
}

export async function releaseLease(db: Db, lease: Lease): Promise<void> {
  await db.query(
    `UPDATE session_leases SET expires_at = now()
     WHERE session_id = $1 AND worker_id = $2 AND epoch = $3`,
    [lease.sessionId, lease.workerId, lease.epoch],
  );
}
