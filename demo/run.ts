/**
 * A reproducible two-person demo: the real server, worker, log and git, with
 * the agent's turns scripted so every run plays out the same way.
 *
 *   DATABASE_URL=... npx tsx demo/run.ts
 *
 * Seeds a repository (a local bare repo standing in for GitHub), connects
 * fake GitHub accounts for Alice and Bob, creates a session that Alice
 * drives, then serves it. demo/record.mjs drives two browser windows
 * through it and records the video.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { saveCredentials } from "../src/credentials.js";
import { connect, migrate } from "../src/db.js";
import { EVENTS_CHANNEL } from "../src/events.js";
import { gitTools } from "../src/git-tools.js";
import { sessionsNeedingSummaries, writeSummaries } from "../src/handoff.js";
import type { Model, ModelRequest, ModelResponse } from "../src/model.js";
import { startServer } from "../src/server.js";
import { createSession, sessionsNeedingWork } from "../src/sessions.js";
import { fileTools, registry } from "../src/tools.js";
import { driveSession, type WorkerDeps } from "../src/worker.js";

const THINK_MS = Number(process.env.DEMO_THINK_MS ?? 1200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ids = 0;
const call = (name: string, input: unknown, text?: string): ModelResponse => ({
  content: [
    ...(text ? [{ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock] : []),
    { type: "tool_use", id: `toolu_demo_${++ids}`, name, input } as Anthropic.Beta.BetaToolUseBlock,
  ],
  stopReason: "tool_use",
});
const say = (text: string): ModelResponse => ({
  content: [{ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock],
  stopReason: "end_turn",
});

const TEST_BEFORE = `test("payouts come back newest first", async () => {
  const rows = await listPayouts(account);
  expect(rows.map((r) => r.id)).toEqual(sorted(rows, "createdAt"));
});
`;
const TEST_AFTER = TEST_BEFORE.replace(`sorted(rows, "createdAt")`, `sorted(rows, "createdAt", "id")`);
const TEST_COMMENTED = TEST_AFTER.replace(
  "  const rows",
  "  // Payouts created in the same millisecond tie on createdAt; id breaks the tie.\n  const rows",
);
const SQL_BEFORE = "SELECT * FROM payouts WHERE account_id = $1 ORDER BY created_at DESC;\n";
const SQL_AFTER = SQL_BEFORE.replace("created_at DESC", "created_at DESC, id DESC");

/**
 * The agent's side of the demo. It picks its next turn from the latest
 * instruction it was given and how many turns it has taken since, so the
 * script holds however the people in the windows pace things.
 */
const beats: Array<{ when: RegExp; turns: ModelResponse[] }> = [
  {
    when: /fails about one run in ten/,
    turns: [
      call("read_file", { path: "payout.test.ts" }),
      call(
        "write_file",
        { path: "payout.test.ts", contents: TEST_AFTER },
        "Two payouts created in the same millisecond tie on createdAt and come back in either order, so the test fails at random. I'll break the tie by id.",
      ),
      say("Fixed the test: it now sorts by createdAt, then id."),
    ],
  },
  {
    when: /ORDER BY/,
    turns: [
      call("read_file", { path: "payouts.sql" }),
      call("write_file", { path: "payouts.sql", contents: SQL_AFTER }, "The query has the same tie. Adding id to the ORDER BY."),
      call("git_commit", { message: "Break payout ordering ties by id" }),
      say("Committed the test and the query together."),
    ],
  },
  {
    when: /push/,
    turns: [
      call("write_file", { path: "payout.test.ts", contents: TEST_COMMENTED }),
      call("git_commit", { message: "Explain the payout tiebreak" }),
      call("git_push", { branch: "main" }, "Committed. Pushing to main."),
      say("Pushed both commits to main."),
    ],
  },
];

class DemoAgent implements Model {
  async next(req: ModelRequest): Promise<ModelResponse> {
    await sleep(THINK_MS);
    const isInstruction = (m: ModelRequest["messages"][number]) =>
      m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "text");
    const lastInstruction = req.messages.length - 1 - [...req.messages].reverse().findIndex(isInstruction);
    const said = (req.messages[lastInstruction].content as Anthropic.Beta.BetaContentBlockParam[])
      .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const turnsSince = req.messages.slice(lastInstruction).filter((m) => m.role === "assistant").length;
    const beat = beats.find((b) => b.when.test(said));
    return beat?.turns[turnsSince] ?? say("Done.");
  }
}

/** Writes the handoff note from the log it is given, citing real event numbers. */
class DemoNotes implements Model {
  async next(req: ModelRequest): Promise<ModelResponse> {
    await sleep(THINK_MS * 2);
    const log = req.messages[0].content as string;
    const seq = (pattern: RegExp) => {
      const line = log.split("\n").find((l) => pattern.test(l));
      return line ? `[${line.split(" ")[0]}]` : "";
    };
    return say(
      [
        "Goal:",
        `Stop payout.test.ts failing about one run in ten ${seq(/instruction from alice: .*one run in ten/)}.`,
        "",
        "Done:",
        `Payouts created in the same millisecond came back in either order ${seq(/said: .*same millisecond/)}. ` +
          `The test now breaks ties by id, and so does payouts.sql, which Bob suggested and Alice accepted ${seq(/suggestion from bob/)} ${seq(/accepted by alice/)}. ` +
          `Both changes are committed as Alice ${seq(/tool result .*committed/)}.`,
        "",
        "In flight:",
        "Nothing is running or waiting on anyone. The commit hasn't been pushed yet.",
        "",
        "Watch out for:",
        "Nothing.",
      ].join("\n"),
    );
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();

/** A bare repository holding the flaky test, standing in for GitHub. */
function seedRepo(): string {
  const remote = mkdtempSync(join(tmpdir(), "demo-origin-"));
  const seed = mkdtempSync(join(tmpdir(), "demo-seed-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "payout.test.ts"), TEST_BEFORE);
  writeFileSync(join(seed, "payouts.sql"), SQL_BEFORE);
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Dana Kim", "-c", "user.email=dana@example.com", "commit", "-q", "-m", "Add payouts query and test");
  git(seed, "push", "-q", remote, "main");
  return remote;
}

const db = connect();
await migrate(db);
const key = randomBytes(32);
for (const [userId, gitName] of [["alice", "Alice Ng"], ["bob", "Bob Ortiz"]]) {
  // Demo tokens: the remote is a local repository, so nothing checks them.
  await saveCredentials(db, key, { userId, gitName, gitEmail: `${userId}@example.com`, token: `demo-token-${userId}` });
}
const remote = seedRepo();
const sessionId = await createSession(db, { title: "Fix the flaky payout test", createdBy: "alice", repoUrl: remote });

const server = await startServer(db, { port: Number(process.env.PORT ?? 3000), credentialsKey: key });
const deps: WorkerDeps = {
  db,
  model: new DemoAgent(),
  tools: registry([...fileTools, ...gitTools]),
  credentialsKey: key,
  workerId: "demo-worker",
  workspaceRoot: mkdtempSync(join(tmpdir(), "demo-workspaces-")),
};
const notes = { db, model: new DemoNotes(), workerId: "demo-worker" };

const busy = new Set<string>();
const once = (k: string, f: () => Promise<unknown>) => {
  if (busy.has(k)) return;
  busy.add(k);
  void f().catch((err) => console.error(err)).finally(() => busy.delete(k));
};
async function sweep() {
  for (const id of await sessionsNeedingWork(db)) once(`agent:${id}`, () => driveSession(deps, id));
  for (const id of await sessionsNeedingSummaries(db)) once(`notes:${id}`, () => writeSummaries(notes, id));
}
const listener = await db.connect();
await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
listener.on("notification", () => void sweep());
setInterval(() => void sweep(), 1000);

console.log(JSON.stringify({ url: server.url, sessionId, remote }));
