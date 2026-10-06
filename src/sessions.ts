import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { append } from "./events.js";

export async function createSession(
  db: Db,
  opts: { title: string; createdBy: string; repoUrl?: string; defaultBranch?: string },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO sessions (id, title, created_by, driver, repo_url, default_branch) VALUES ($1, $2, $3, $3, $4, $5)",
    [id, opts.title, opts.createdBy, opts.repoUrl ?? null, opts.defaultBranch ?? "main"],
  );
  await append(db, id, [{ type: "session_created", actor: opts.createdBy, payload: { title: opts.title } }]);
  return id;
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
