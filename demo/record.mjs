// Records the two-window demo: Alice's and Bob's browsers side by side,
// driven through demo/run.ts, with a caption for each beat.
//
//   npm i --no-save playwright && npx playwright install chromium
//   DATABASE_URL=... node demo/record.mjs [out-dir]
//
// Writes demo.webm, demo.mp4 and demo.gif to out-dir (default demo/out).
// The mp4 and gif need ffmpeg on the PATH.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright";

const out = resolve(process.argv[2] ?? "demo/out");
mkdirSync(out, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the demo server and wait for it to say where it is.
const run = spawn(process.execPath, ["--import", "tsx", "demo/run.ts"], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
process.on("exit", () => run.kill());
const { url, sessionId, remote } = await new Promise((ok, fail) => {
  run.on("exit", (code) => fail(new Error(`demo/run.ts exited with ${code}`)));
  createInterface({ input: run.stdout }).on("line", (line) => {
    if (line.startsWith("{")) ok(JSON.parse(line));
  });
});

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; height: 100vh; display: grid; grid-template-rows: auto 1fr auto; background: #0f172a; color: #e2e8f0; font: 16px system-ui, sans-serif; }
  #cap { padding: 14px 22px; font-size: 21px; line-height: 1.35; min-height: 58px; }
  #wins { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 12px; min-height: 0; }
  .win { display: flex; flex-direction: column; border-radius: 8px; overflow: hidden; background: #fff; min-height: 0; }
  .win h2 { margin: 0; padding: 7px 12px; font-size: 14px; font-weight: 600; background: #1e293b; color: #cbd5e1; }
  iframe { border: 0; flex: 1; width: 100%; }
  #git { margin: 12px; padding: 10px 14px; background: #020617; border-radius: 8px; font: 13px/1.5 ui-monospace, monospace; white-space: pre; min-height: 60px; color: #a5f3fc; }
</style>
<div id="cap"></div>
<div id="wins">
  <div class="win"><h2>Alice's browser</h2><iframe id="alice" src="${url}/?as=alice#${sessionId}"></iframe></div>
  <div class="win"><h2>Bob's browser</h2><iframe id="bob" src="${url}/?as=bob#${sessionId}"></iframe></div>
</div>
<div id="git"></div>`;

process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});
const browser = await chromium.launch();
const size = { width: 1600, height: 1000 };
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size }, colorScheme: "light" });
const page = await context.newPage();
await page.setContent(html);
const alice = page.frameLocator("#alice");
const bob = page.frameLocator("#bob");

const caption = (text) => page.locator("#cap").evaluate((n, t) => (n.textContent = t), text);
const say = async (who, text) => {
  await who.locator("#text").pressSequentially(text, { delay: 28 });
  await pause(400);
  await who.locator("#text").press("Enter");
};
const sees = (who, text) => who.getByText(text).first().waitFor({ timeout: 30_000 });
function showRemote(title) {
  const log = execFileSync("git", ["log", "main", "--format=%h  author: %<(10)%an  committer: %<(18)%cn  %s"], {
    cwd: remote,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).toString().trim();
  return page.locator("#git").evaluate((n, t) => (n.textContent = t), `${title}\n${log}`);
}

await showRemote("origin/main");
await caption("Alice and Bob share one coding agent on a repository. Alice started the session, so she is driving.");
await alice.locator(".who").nth(1).waitFor();
await bob.locator(".who").nth(1).waitFor();
await pause(3500);

await caption("Alice gives the agent a task. Bob watches every step live.");
await say(alice, "payout.test.ts fails about one run in ten. Find out why and fix it.");
await sees(alice, "Fixed the test");
await pause(2500);

await caption("Bob isn't driving, so his message is a suggestion. The agent doesn't see it unless Alice accepts.");
await say(bob, "The query has the same bug: fix the ORDER BY in payouts.sql too.");
await alice.getByRole("button", { name: "Accept" }).waitFor();
await pause(3500);
await caption("Alice accepts. The agent reads it as Bob's idea, accepted by Alice, and commits as Alice.");
await alice.getByRole("button", { name: "Accept" }).click();
await sees(alice, "Committed the test and the query together.");
await pause(3000);

await caption("Alice has to leave, so she passes the wheel to Bob. Bob gets a handoff note: a summary that cites the log, and facts read straight from it.");
await alice.getByRole("button", { name: "Pass the wheel" }).click();
const note = bob.locator(".ev.note");
await note.waitFor({ timeout: 30_000 });
await note.scrollIntoViewIfNeeded();
await pause(7000);

await caption("Bob is driving now, so whatever the agent does next, it does as Bob.");
await say(bob, "Add a comment explaining the tiebreak, commit it, and push to main.");
await sees(bob, "needs approval");
await caption("A push to main needs a maintainer other than the person asking. Bob can only deny it. Alice can approve it.");
await pause(5000);
await alice.getByRole("button", { name: "Approve" }).click();
await sees(bob, "Pushed both commits to main.");
await pause(1500);

await caption("On the remote, each commit is authored by the person who asked for it, with the agent as committer.");
await showRemote("origin/main, after the push");
await pause(7000);

const video = page.video();
await context.close();
await browser.close();
run.kill();

const webm = join(out, "demo.webm");
renameSync(await video.path(), webm);
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
try {
  ffmpeg("-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", join(out, "demo.mp4"));
  ffmpeg(
    "-i", webm,
    "-vf", "setpts=0.75*PTS,fps=6,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    join(out, "demo.gif"),
  );
} catch (err) {
  console.error("ffmpeg failed; the webm is still there:", err.message);
}
console.log(`wrote ${out}/demo.{webm,mp4,gif}`);
process.exit(0);
