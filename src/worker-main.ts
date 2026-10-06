import { hostname } from "node:os";
import { loadKey } from "./credentials.js";
import { connect } from "./db.js";
import { EVENTS_CHANNEL } from "./events.js";
import { ClaudeModel } from "./model.js";
import { sessionsNeedingWork } from "./sessions.js";
import { gitTools } from "./git-tools.js";
import { fileTools, registry } from "./tools.js";
import { driveSession, type WorkerDeps } from "./worker.js";

// Long-running worker. Wakes on every appended event via LISTEN/NOTIFY, and
// also sweeps on a timer so sessions orphaned by a crashed worker resume
// once their lease expires.
const db = connect();
const deps: WorkerDeps = {
  db,
  model: new ClaudeModel(),
  tools: registry([...fileTools, ...gitTools]),
  credentialsKey: process.env.CREDENTIALS_KEY ? loadKey() : undefined,
  workerId: `${hostname()}:${process.pid}`,
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "workspaces",
};

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
}

const listener = await db.connect();
await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
listener.on("notification", () => void sweep());
setInterval(() => void sweep(), 5_000);
await sweep();
console.log(`worker ${deps.workerId} listening`);
