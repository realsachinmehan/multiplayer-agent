import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "./db.js";
import { AGENT, append, LeaseLostError, readEvents } from "./events.js";
import { acquireLease, releaseLease, renewLease, type Lease } from "./lease.js";
import type { Model } from "./model.js";
import { fold, type SessionState } from "./state.js";
import type { ToolRegistry } from "./tools.js";

export type WorkerDeps = {
  db: Db;
  model: Model;
  tools: ToolRegistry;
  workerId: string;
  workspaceRoot: string;
  leaseTtlMs?: number;
  maxSteps?: number;
  system?: string;
};

export type DriveResult = "idle" | "busy" | "max_steps";

const DEFAULT_SYSTEM = `You are a coding agent working in a shared session. Several engineers can watch and send you instructions; each instruction is prefixed with the sender's name in brackets. If two instructions conflict, say so rather than silently picking one. Use the tools to read and change files in the repository.`;

/**
 * Runs a session until the agent has nothing left to do. Each step re-reads
 * the log, decides one action from the folded state, performs it, and
 * appends the result. The log is the checkpoint: a worker that dies at any
 * point leaves a log another worker can resume from.
 */
export async function driveSession(deps: WorkerDeps, sessionId: string): Promise<DriveResult> {
  const ttl = deps.leaseTtlMs ?? 30_000;
  const lease = await acquireLease(deps.db, sessionId, deps.workerId, ttl);
  if (!lease) return "busy";
  await deps.db.query("UPDATE sessions SET status = 'running' WHERE id = $1", [sessionId]);
  const workspace = join(deps.workspaceRoot, sessionId);
  await mkdir(workspace, { recursive: true });
  // A model call or tool can outlast the TTL, so keep the lease alive in the
  // background. If renewal fails the fence stops our next write anyway.
  const heartbeat = setInterval(() => void renewLease(deps.db, lease, ttl).catch(() => {}), ttl / 3);

  try {
    for (let step = 0; step < (deps.maxSteps ?? 50); step++) {
      if (!(await renewLease(deps.db, lease, ttl))) throw new LeaseLostError(sessionId, lease.epoch);
      const state = fold(await readEvents(deps.db, sessionId));

      if (state.next.kind === "idle") {
        // Only go idle if nothing arrived since we read the log; otherwise a
        // message posted in that gap would sit unanswered.
        const { rowCount } = await deps.db.query(
          "UPDATE sessions SET status = 'idle' WHERE id = $1 AND last_seq = $2",
          [sessionId, state.lastSeq],
        );
        if (rowCount === 1) return "idle";
        continue;
      }
      if (state.next.kind === "call_model") await modelStep(deps, lease, state);
      else await toolStep(deps, lease, state, workspace);
    }
    return "max_steps";
  } finally {
    clearInterval(heartbeat);
    await releaseLease(deps.db, lease).catch(() => {});
  }
}

async function modelStep(deps: WorkerDeps, lease: Lease, state: SessionState): Promise<void> {
  // If the worker dies during this call nothing has been written, so the
  // next worker simply asks again. Model calls have no side effects.
  const res = await deps.model.next({
    system: deps.system ?? DEFAULT_SYSTEM,
    tools: [...deps.tools.values()].map((t) => t.definition),
    messages: state.messages,
  });
  await append(
    deps.db,
    lease.sessionId,
    [
      {
        type: "model_response",
        actor: AGENT,
        onBehalfOf: state.steerer,
        payload: { content: res.content, stopReason: res.stopReason, basedOnSeq: state.lastSeq },
      },
    ],
    lease,
  );
}

async function toolStep(deps: WorkerDeps, lease: Lease, state: SessionState, workspace: string): Promise<void> {
  if (state.next.kind !== "run_tool") return;
  const { toolUse, resumed } = state.next;
  const tool = deps.tools.get(toolUse.name);
  const meta = { actor: AGENT, onBehalfOf: state.steerer };
  const finish = (output: string, isError: boolean) =>
    append(deps.db, lease.sessionId, [{ type: "tool_finished", ...meta, payload: { toolUseId: toolUse.id, output, isError } }], lease);

  if (!tool) return void (await finish(`unknown tool: ${toolUse.name}`, true));

  if (resumed && !tool.idempotent) {
    // The previous worker started this call and never recorded the result.
    // Running it again could double a side effect, so report it instead.
    return void (await finish(
      `${toolUse.name} was interrupted by a worker restart; it may or may not have taken effect. Check before retrying.`,
      true,
    ));
  }

  if (!resumed) {
    await append(
      deps.db,
      lease.sessionId,
      [{ type: "tool_started", ...meta, payload: { toolUseId: toolUse.id, name: toolUse.name, input: toolUse.input } }],
      lease,
    );
  }

  let output: string;
  let isError = false;
  try {
    output = await tool.run(toolUse.input as Anthropic.Beta.BetaToolUseBlock["input"], {
      sessionId: lease.sessionId,
      workspace,
      onBehalfOf: state.steerer,
    });
  } catch (err) {
    output = err instanceof Error ? err.message : String(err);
    isError = true;
  }
  await finish(output, isError);
}
