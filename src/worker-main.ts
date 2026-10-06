import { hostname } from "node:os";
import { loadKey } from "./credentials.js";
import { connect } from "./db.js";
import { EVENTS_CHANNEL } from "./events.js";
import { modelFromEnv } from "./model.js";
import { sessionsNeedingWork } from "./sessions.js";
import { gitTools } from "./git-tools.js";
import { sessionsNeedingSummaries, writeSummaries, type SummaryDeps } from "./handoff.js";
import { fileTools, registry } from "./tools.js";
import { driveSession, type WorkerDeps } from "./worker.js";

// Long-running worker. Wakes on every appended event via LISTEN/NOTIFY, and
// also sweeps on a timer so sessions orphaned by a crashed worker resume
// once their lease expires.
const db = connect();
const deps: WorkerDeps = {
  db,
  model: modelFromEnv(),
  tools: registry([...fileTools, ...gitTools]),
  credentialsKey: process.env.CREDENTIALS_KEY ? loadKey() : undefined,
  workerId: `${hostname()}:${process.pid}`,
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "workspaces",
};

// Handoff notes run beside the agent loop, with their own claims, so a note
// for a session never waits for (or holds up) the agent working on it.
const summaryDeps: SummaryDeps = { db, model: deps.model, workerId: deps.workerId };
const writingNotes = new Set<string>();
async function notes(sessionId: string) {
  if (writingNotes.has(sessionId)) return;
  writingNotes.add(sessionId);
  try {
    const n = await writeSummaries(summaryDeps, sessionId);
    if (n) console.log(`session ${sessionId}: wrote ${n} handoff note${n === 1 ? "" : "s"}`);
  } catch (err) {
    console.error(`session ${sessionId} notes failed:`, err);
  } finally {
    writingNotes.delete(sessionId);
  }
}

const running = new Set<string>();
async function drive(sessionId: string) {
  if (running.has(sessionId)) return;
  running.add(sessionId);
  try {
    const result = await driveSession(deps, sessionId);
    console.log(`session ${sessionId}: ${result}`);
  } catch (err) {
    console.error(`session ${sessionId} failed:`, err);
  } finally {
    running.delete(sessionId);
  }
}

async function sweep() {
  for (const id of await sessionsNeedingWork(db)) void drive(id);
  for (const id of await sessionsNeedingSummaries(db)) void notes(id);
}

const listener = await db.connect();
await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
listener.on("notification", () => void sweep());
setInterval(() => void sweep(), 5_000);
await sweep();
console.log(`worker ${deps.workerId} listening`);
