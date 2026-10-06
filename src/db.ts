import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export type Db = pg.Pool;

export function connect(url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/mpagent"): Db {
  return new pg.Pool({ connectionString: url });
}

export async function migrate(db: Db): Promise<void> {
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).sort()) {
    await db.query(readFileSync(join(dir, file), "utf8"));
  }
}

export async function withTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}
