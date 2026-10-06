import type pg from "pg";
import type { Db } from "./db.js";
import { appendDecided, readEvents, type AppendInput, type SessionEvent } from "./events.js";
import { fold, type SessionState } from "./state.js";

/**
 * Everything a person can do to a session. Each command locks the session,
 * folds the log as it stands, checks the rules, and appends in the same
 * transaction, so two people acting at the same moment are applied one
 * after the other and the second is judged against the first's result.
 *
 * The rules:
 * - One person drives. The driver's messages are instructions to the agent.
 *   Everyone else's are suggestions, which the driver accepts or dismisses.
 * - The driver can pass the wheel to anyone. Anyone can claim it when the
 *   driver isn't watching. Instructions the old driver queued that the
 *   agent hasn't read yet are withdrawn: they carried the old driver's
 *   authority, and the new driver can re-issue what they want.
 * - Anyone can pause the agent. Only the driver can resume it.
 * - An instruction can be withdrawn by its author until the agent reads it.
 */
export class CommandError extends Error {
  constructor(
    readonly status: 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

type Decide = (state: SessionState, c: pg.PoolClient) => Promise<AppendInput[]> | AppendInput[];

async function command(db: Db, sessionId: string, decide: Decide): Promise<SessionEvent[]> {
  return appendDecided(db, sessionId, async (c) => {
    const state = fold(await readEvents(c, sessionId));
    const inputs = await decide(state, c);
    // New instructions and a resume give the agent work; tell the workers.
    if (inputs.some((e) => e.type === "user_message" || e.type === "resumed")) {
      await c.query("UPDATE sessions SET status = 'pending' WHERE id = $1 AND status = 'idle'", [sessionId]);
    }
    return inputs;
  });
}

function requireDriver(state: SessionState, user: string, action: string) {
  if (state.driver !== user) throw new CommandError(403, `only the driver (${state.driver}) can ${action}`);
}

/** The driver instructs the agent; anyone else makes a suggestion. */
export async function postMessage(db: Db, sessionId: string, user: string, text: string): Promise<SessionEvent> {
  const [e] = await command(db, sessionId, (state) => [
    state.driver === user
      ? { type: "user_message", actor: user, payload: { text } }
      : { type: "suggestion", actor: user, payload: { text } },
  ]);
  return e;
}

export async function acceptSuggestion(db: Db, sessionId: string, user: string, suggestionSeq: number) {
  const [e] = await command(db, sessionId, (state) => {
    requireDriver(state, user, "accept suggestions");
    const s = state.suggestions.find((s) => s.seq === suggestionSeq);
    if (!s) throw new CommandError(409, `suggestion #${suggestionSeq} is not pending`);
    return [{ type: "user_message", actor: user, payload: { text: s.text, suggestedBy: s.author, suggestionSeq } }];
  });
  return e;
}

export async function dismissSuggestion(db: Db, sessionId: string, user: string, suggestionSeq: number) {
  const [e] = await command(db, sessionId, (state) => {
    requireDriver(state, user, "dismiss suggestions");
    if (!state.suggestions.some((s) => s.seq === suggestionSeq)) {
      throw new CommandError(409, `suggestion #${suggestionSeq} is not pending`);
    }
    return [{ type: "suggestion_dismissed", actor: user, payload: { suggestionSeq } }];
  });
  return e;
}

/** Takes back your own unread instruction or pending suggestion. */
export async function withdraw(db: Db, sessionId: string, user: string, targetSeq: number) {
  const [e] = await command(db, sessionId, (state) => {
    const mine = [...state.queued, ...state.suggestions].find((q) => q.seq === targetSeq);
    if (!mine) throw new CommandError(409, `#${targetSeq} was already read by the agent or resolved`);
    if (mine.author !== user) throw new CommandError(403, `only ${mine.author} can withdraw #${targetSeq}`);
    return [{ type: "withdrawn", actor: user, payload: { targetSeq, reason: "author" } }];
  });
  return e;
}

function handOver(state: SessionState, user: string, to: string, reason: "passed" | "claimed"): AppendInput[] {
  const from = state.driver!;
  return [
    { type: "driver_changed", actor: user, payload: { from, to, reason } },
    ...state.queued
      .filter((q) => q.author === from)
      .map((q): AppendInput => ({ type: "withdrawn", actor: user, payload: { targetSeq: q.seq, reason: "driver_changed" } })),
  ];
}

export async function passDriver(db: Db, sessionId: string, user: string, to: string) {
  return command(db, sessionId, (state) => {
    requireDriver(state, user, "pass the wheel");
    if (to === user) throw new CommandError(409, "you are already driving");
    return handOver(state, user, to, "passed");
  });
}

/** Take the wheel from a driver who isn't watching the session any more. */
export async function claimDriver(db: Db, sessionId: string, user: string) {
  return command(db, sessionId, async (state, c) => {
    if (state.driver === user) throw new CommandError(409, "you are already driving");
    const { rowCount } = await c.query(
      "SELECT 1 FROM presence WHERE session_id = $1 AND user_id = $2 AND expires_at > now()",
      [sessionId, state.driver],
    );
    if (rowCount) throw new CommandError(409, `${state.driver} is still here; ask them to pass the wheel`);
    return handOver(state, user, user, "claimed");
  });
}

/** Anyone can stop the agent. It finishes a tool that is already running. */
export async function pause(db: Db, sessionId: string, user: string) {
  const [e] = await command(db, sessionId, (state) => {
    if (state.paused) throw new CommandError(409, "already paused");
    return [{ type: "paused", actor: user, payload: {} }];
  });
  return e;
}

export async function resume(db: Db, sessionId: string, user: string) {
  const [e] = await command(db, sessionId, (state) => {
    requireDriver(state, user, "resume the agent");
    if (!state.paused) throw new CommandError(409, "not paused");
    return [{ type: "resumed", actor: user, payload: {} }];
  });
  return e;
}
