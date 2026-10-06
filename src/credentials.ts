import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export type Credentials = { userId: string; gitName: string; gitEmail: string; token: string };

/** A 32-byte key, from CREDENTIALS_KEY as 64 hex characters. */
export function loadKey(hex = process.env.CREDENTIALS_KEY): Buffer {
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("CREDENTIALS_KEY must be 64 hex characters (32 bytes); try: openssl rand -hex 32");
  }
  return Buffer.from(hex, "hex");
}

function encrypt(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, blob: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

export async function saveCredentials(db: Db, key: Buffer, c: Credentials): Promise<void> {
  await db.query(
    `INSERT INTO credentials (user_id, git_name, git_email, token_enc) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET git_name = EXCLUDED.git_name, git_email = EXCLUDED.git_email,
           token_enc = EXCLUDED.token_enc, updated_at = now()`,
    [c.userId, c.gitName, c.gitEmail, encrypt(key, c.token)],
  );
}

export async function loadCredentials(db: Db, key: Buffer, userId: string): Promise<Credentials | null> {
  const { rows } = await db.query("SELECT git_name, git_email, token_enc FROM credentials WHERE user_id = $1", [userId]);
  if (!rows.length) return null;
  return { userId, gitName: rows[0].git_name, gitEmail: rows[0].git_email, token: decrypt(key, rows[0].token_enc) };
}

export async function hasCredentials(db: Db, userId: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM credentials WHERE user_id = $1", [userId]);
  return rowCount === 1;
}
