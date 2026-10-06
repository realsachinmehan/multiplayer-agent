import type pg from "pg";
import type { Db } from "./db.js";
import { appendDecided, readEvents, type AppendInput, type SessionEvent } from "./events.js";
import { atLeast, ROLES, type Role } from "./roles.js";
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
 * - Viewers only watch. Risky tool calls wait for approval from someone
 *   whose role the call's policy names, and some need a second person.
 * - Roles come from the log too, so every check uses the role a person has
 *   at the moment they act, not when they joined.
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
    // These give the agent something to do; tell the workers.
    if (inputs.some((e) => ["user_message", "resumed", "approval_granted", "approval_denied"].includes(e.type))) {
      await c.query("UPDATE sessions SET status = 'pending' WHERE id = $1 AND status = 'idle'", [sessionId]);
    }
    return inputs;
  });
}

function requireDriver(state: SessionState, user: string, action: string) {
  if (state.driver !== user) throw new CommandError(403, `only the driver (${state.driver}) can ${action}`);
}

function requireRole(state: SessionState, user: string, min: Role, action: string) {
  if (!atLeast(state.roleOf(user), min)) {
    throw new CommandError(403, `${user} is a ${state.roleOf(user)}; ${action} needs a ${min} or above`);
  }
}

/** The driver instructs the agent; anyone else makes a suggestion. */
export async function postMessage(db: Db, sessionId: string, user: string, text: string): Promise<SessionEvent> {
  const [e] = await command(db, sessionId, (state) => {
    requireRole(state, user, "member", "sending messages");
    return [
      state.driver === user
        ? { type: "user_message", actor: user, payload: { text } }
        : { type: "suggestion", actor: user, payload: { text } },
    ];
  });
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
    if (!atLeast(state.roleOf(to), "member")) throw new CommandError(409, `${to} is a viewer and can't drive`);
    return handOver(state, user, to, "passed");
  });
}

/** Take the wheel from a driver who isn't watching the session any more. */
export async function claimDriver(db: Db, sessionId: string, user: string) {
  return command(db, sessionId, async (state, c) => {
    requireRole(state, user, "member", "driving");
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
    requireRole(state, user, "member", "pausing");
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

function pendingApproval(state: SessionState, toolUseId: string) {
  const a = state.approvals.find((a) => a.toolUseId === toolUseId);
  if (!a) throw new CommandError(409, "that call is not waiting for approval (already decided, or cancelled by a pause)");
  return a;
}

/**
 * Signs off on a gated tool call. The approver needs the role the call's
 * policy names, and when the policy says so, must be someone other than the
 * person the agent is acting for.
 */
export async function approve(db: Db, sessionId: string, user: string, toolUseId: string) {
  const [e] = await command(db, sessionId, (state) => {
    const a = pendingApproval(state, toolUseId);
    requireRole(state, user, a.minRole, `approving a call that ${a.reason}`);
    if (!a.allowSelf && user === a.requestedFor) {
      throw new CommandError(403, `a call that ${a.reason} needs a second person; ${user} asked for it`);
    }
    return [{ type: "approval_granted", actor: user, payload: { toolUseId } }];
  });
  return e;
}

/** Turns a gated call down. Anyone who could approve it can, and so can the person it was for. */
export async function deny(db: Db, sessionId: string, user: string, toolUseId: string, reason?: string) {
  const [e] = await command(db, sessionId, (state) => {
    const a = pendingApproval(state, toolUseId);
    if (user !== a.requestedFor) requireRole(state, user, a.minRole, `denying a call that ${a.reason}`);
    return [{ type: "approval_denied", actor: user, payload: { toolUseId, ...(reason ? { reason } : {}) } }];
  });
  return e;
}

export async function setRole(db: Db, sessionId: string, by: string, user: string, role: Role) {
  if (!ROLES.includes(role)) throw new CommandError(409, `unknown role ${role}`);
  const [e] = await command(db, sessionId, (state) => {
    requireRole(state, by, "maintainer", "changing roles");
    const maintainers = Object.entries(state.roles).filter(([, r]) => r === "maintainer").map(([u]) => u);
    if (role !== "maintainer" && maintainers.length === 1 && maintainers[0] === user) {
      throw new CommandError(409, `${user} is the last maintainer`);
    }
    if (role === "viewer" && state.driver === user) {
      throw new CommandError(409, `${user} is driving; pass the wheel before making them a viewer`);
    }
    return [{ type: "role_changed", actor: by, payload: { user, role } }];
  });
  return e;
}
