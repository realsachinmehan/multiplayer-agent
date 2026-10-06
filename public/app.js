// A deliberately small client: it renders the session log and nothing else.
// Everything a viewer sees, including who drives and what is still queued,
// is derived from the event stream, so two windows always agree.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let me = params.get("as") ?? localStorage.getItem("me") ?? "";
let sessionId = location.hash.slice(1);
let source = null;

// Steering state, rebuilt from events as they arrive.
let s;
function resetState() {
  s = {
    driver: null,
    paused: null, // who paused, or null
    lastEvent: null,
    readUpTo: 0, // highest seq the agent has read
    queued: new Map(), // unread instructions: seq -> author
    suggestions: new Map(), // pending suggestions: seq -> author
    nodes: new Map(), // seq -> rendered element, for later status changes
    watchers: [],
    roles: new Map(), // user -> role; anyone unlisted is a member
    lastSeq: 0,
    toolNames: new Map(), // toolUseId -> tool name
    workSeqs: [], // seqs of everything except handoff notes, to count what is newer than a note
    notes: [], // written notes: { upToSeq, since: element }
    noteRequests: new Map(), // requestSeq -> { node, reason }, until the note arrives
    lastVisit: 0, // highest seq this browser had seen before this visit
    approvals: new Map(), // toolUseId -> pending approval request, plus its seq
  };
}
const roleOf = (u) => s.roles.get(u) ?? "member";
const RANK = { viewer: 0, member: 1, maintainer: 2 };
resetState();

$("me").value = me;
$("me").addEventListener("change", () => {
  me = $("me").value.trim();
  localStorage.setItem("me", me);
  open();
});

async function api(path, init = {}) {
  const res = await fetch(`${path}${path.includes("?") ? "&" : "?"}as=${encodeURIComponent(me)}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// Commands can lose a race with someone else; show why instead of failing silently.
async function act(path, body) {
  $("error").textContent = "";
  try {
    await api(`/sessions/${sessionId}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  } catch (err) {
    $("error").textContent = err.message;
  }
}

async function loadSessions() {
  const list = await api("/sessions");
  const sel = $("sessions");
  sel.length = 1;
  for (const x of list) sel.add(new Option(`${x.title} (${x.created_by})`, x.id));
  sel.value = sessionId;
}

$("sessions").addEventListener("change", (e) => {
  location.hash = e.target.value;
});
window.addEventListener("hashchange", () => {
  sessionId = location.hash.slice(1);
  open();
});

$("new").addEventListener("click", () => {
  if (!me) return alert("Enter your name first.");
  $("new-form").reset();
  $("new-dialog").showModal();
});
$("new-dialog").addEventListener("close", async () => {
  if ($("new-dialog").returnValue !== "ok") return;
  const title = $("new-title").value.trim();
  const repoUrl = $("new-repo").value.trim() || undefined;
  try {
    const { id } = await api("/sessions", { method: "POST", body: JSON.stringify({ title, repoUrl }) });
    sessionId = id;
    await loadSessions();
    location.hash = id;
  } catch (err) {
    alert(err.message);
  }
});

// Your own GitHub account, which the agent uses only for what you steer.
async function loadMe() {
  $("github").hidden = !me;
  if (!me) return;
  const { githubConnected } = await api("/me");
  $("github").textContent = githubConnected ? "GitHub connected ✓" : "Connect GitHub";
}
$("github").addEventListener("click", () => {
  $("github-form").reset();
  $("gh-name").value = me;
  $("github-dialog").showModal();
});
$("github-dialog").addEventListener("close", async () => {
  if ($("github-dialog").returnValue !== "ok") return;
  const token = $("gh-token").value;
  $("gh-token").value = "";
  try {
    await api("/me/github", {
      method: "PUT",
      body: JSON.stringify({ token, name: $("gh-name").value, email: $("gh-email").value }),
    });
  } catch (err) {
    alert(err.message);
  }
  await loadMe();
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  await act("messages", { text });
});
$("claim").addEventListener("click", () => act("driver/claim"));
$("pass-btn").addEventListener("click", () => act("driver", { to: $("pass-to").value }));
$("pause").addEventListener("click", () => act("pause"));
$("resume").addEventListener("click", () => act("resume"));
$("role-btn").addEventListener("click", () => act("roles", { user: $("role-user").value, role: $("role-value").value }));
$("catch-up").addEventListener("click", () => act("summaries", { sinceSeq: s.lastVisit }));

// Remembers how far you got in each session, so "Catch me up" can cover
// just what happened since your last visit.
const seenKey = () => `seen:${sessionId}`;
function rememberSeen(seq) {
  try {
    if (seq > (Number(localStorage.getItem(seenKey())) || 0)) localStorage.setItem(seenKey(), String(seq));
  } catch {}
}
function lastVisit() {
  try {
    return Number(localStorage.getItem(seenKey())) || 0;
  } catch {
    return 0;
  }
}

function open() {
  void loadMe().catch(() => {});
  source?.close();
  resetState();
  s.lastVisit = sessionId ? lastVisit() : 0;
  $("log").replaceChildren();
  $("watchers").replaceChildren();
  const ready = Boolean(me && sessionId);
  $("controls").hidden = !ready;
  $("text").disabled = $("composer").querySelector("button").disabled = !ready;
  if (!ready) {
    $("log").innerHTML = `<p class="empty">${me ? "Pick or start a session." : "Enter your name to join."}</p>`;
    return;
  }
  // after=0 replays the whole log first, so joining late looks the same as
  // having been here all along. EventSource resumes by Last-Event-ID itself.
  source = new EventSource(`/sessions/${sessionId}/stream?after=0&as=${encodeURIComponent(me)}`);
  source.addEventListener("session_event", (m) => {
    render(JSON.parse(m.data));
    refresh();
  });
  source.addEventListener("presence", (m) => {
    s.watchers = JSON.parse(m.data);
    refresh();
  });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let renderingSeq = null;
function line(cls, meta, body, seq) {
  const n = el("div", `ev ${cls}`);
  if (renderingSeq != null) n.dataset.seq = renderingSeq;
  const head = el("div", "meta", meta);
  n.append(head, body);
  $("log").append(n);
  if (seq != null) s.nodes.set(seq, n);
  return n;
}

function mark(seq, cls, tag) {
  const n = s.nodes.get(seq);
  if (!n) return;
  n.classList.add("resolved", ...(cls ? [cls] : []));
  n.querySelector(".tag")?.remove();
  n.querySelector(".actions")?.remove();
  if (tag) n.querySelector(".meta").append(el("span", "tag", tag));
}

function render(e) {
  renderingSeq = e.seq;
  s.lastSeq = e.seq;
  rememberSeen(e.seq);
  if (!e.type.startsWith("summary_")) {
    s.lastEvent = e;
    s.workSeqs.push(e.seq);
  }
  const time = new Date(e.createdAt).toLocaleTimeString();
  const forWhom = e.onBehalfOf ? ` · for ${e.onBehalfOf}` : "";
  switch (e.type) {
    case "session_created":
      s.driver = e.actor;
      s.roles.set(e.actor, "maintainer");
      line("system", time, el("div", "meta", `${e.actor} started “${e.payload.title}” and is driving`));
      break;
    case "user_message": {
      const who = e.payload.suggestedBy ? `${e.payload.suggestedBy}, accepted by ${e.actor}` : e.actor;
      line("human", `${who} · ${time}`, el("div", "msg", e.payload.text), e.seq);
      s.queued.set(e.seq, e.actor);
      if (e.payload.suggestionSeq != null) {
        s.suggestions.delete(e.payload.suggestionSeq);
        mark(e.payload.suggestionSeq, null, `accepted by ${e.actor}`);
      }
      break;
    }
    case "suggestion":
      line("suggestion", `${e.actor} suggests · ${time}`, el("div", "msg", e.payload.text), e.seq);
      s.suggestions.set(e.seq, e.actor);
      break;
    case "suggestion_dismissed":
      s.suggestions.delete(e.payload.suggestionSeq);
      mark(e.payload.suggestionSeq, null, `dismissed by ${e.actor}`);
      break;
    case "withdrawn": {
      const t = e.payload.targetSeq;
      s.queued.delete(t);
      s.suggestions.delete(t);
      mark(t, "withdrawn", e.payload.reason === "driver_changed" ? "dropped at handoff" : "withdrawn");
      break;
    }
    case "driver_changed":
      s.driver = e.payload.to;
      line("system", time, el("div", "meta", e.payload.reason === "claimed"
        ? `${e.payload.to} took the wheel from ${e.payload.from}`
        : `${e.payload.from} passed the wheel to ${e.payload.to}`));
      break;
    case "paused":
      s.paused = e.actor;
      line("system", time, el("div", "meta", `${e.actor} paused the agent`));
      // Pausing cancels anything the agent planned but hadn't started,
      // including calls still waiting for approval.
      for (const a of s.approvals.values()) mark(a.seq, "withdrawn", "cancelled by the pause");
      s.approvals.clear();
      break;
    case "role_changed":
      s.roles.set(e.payload.user, e.payload.role);
      line("system", time, el("div", "meta", `${e.actor} made ${e.payload.user} a ${e.payload.role}`));
      break;
    case "approval_requested": {
      const a = e.payload;
      const who = a.allowSelf ? `a ${a.minRole}` : `a ${a.minRole} other than ${a.requestedFor}`;
      const text = `The agent wants to run ${a.tool} ${describe(a.input)} for ${a.requestedFor}. ` +
        `This ${a.reason}, so it needs ${who} to approve.`;
      line("approval", `needs approval · ${time}`, el("div", "msg", text), e.seq);
      s.approvals.set(a.toolUseId, { ...a, seq: e.seq });
      break;
    }
    case "approval_granted": {
      const a = s.approvals.get(e.payload.toolUseId);
      if (a) mark(a.seq, null, `approved by ${e.actor}`);
      s.approvals.delete(e.payload.toolUseId);
      break;
    }
    case "approval_denied": {
      const a = s.approvals.get(e.payload.toolUseId);
      if (a) mark(a.seq, "withdrawn", `denied by ${e.actor}${e.payload.reason ? `: ${e.payload.reason}` : ""}`);
      s.approvals.delete(e.payload.toolUseId);
      break;
    }
    case "resumed":
      s.paused = null;
      line("system", time, el("div", "meta", `${e.actor} resumed the agent`));
      break;
    case "model_response":
      s.readUpTo = Math.max(s.readUpTo, e.payload.basedOnSeq);
      for (const seq of [...s.queued.keys()]) {
        if (seq <= s.readUpTo) {
          s.queued.delete(seq);
          mark(seq, null, null);
          s.nodes.get(seq)?.classList.remove("resolved");
        }
      }
      for (const b of e.payload.content) {
        if (b.type === "text" && b.text) line("agent", `agent${forWhom} · ${time}`, el("div", "msg", b.text));
        if (b.type === "tool_use") {
          s.toolNames.set(b.id, b.name);
          line("agent", `agent${forWhom} · ${time}`, el("div", "tool", `→ ${b.name} ${describe(b.input)}`));
        }
      }
      break;
    case "summary_requested": {
      const p = e.payload;
      const text = p.reason === "handoff"
        ? `Writing a handoff note for ${p.for}…`
        : `${p.for} asked to catch up${p.sinceSeq ? ` on everything after #${p.sinceSeq}` : ""}. Writing a note…`;
      s.noteRequests.set(e.seq, { node: line("system", time, el("div", "meta", text)), reason: p.reason });
      break;
    }
    case "summary_failed":
      s.noteRequests.get(e.payload.requestSeq)?.node.remove();
      s.noteRequests.delete(e.payload.requestSeq);
      line("system", time, el("div", "meta", `Couldn't write the note for ${e.payload.for}: ${e.payload.error}`));
      break;
    case "summary_ready":
      renderNote(e, time, s.noteRequests.get(e.payload.requestSeq)?.reason);
      s.noteRequests.get(e.payload.requestSeq)?.node.remove();
      s.noteRequests.delete(e.payload.requestSeq);
      break;
    case "tool_finished": {
      const d = el("details", `tool${e.payload.isError ? " error" : ""}`);
      // Side effects say whose name they went out under, so show that line.
      const name = s.toolNames.get(e.payload.toolUseId) ?? "";
      const first = e.payload.output.split("\n")[0].replace(/:$/, "").slice(0, 120);
      const telling = e.payload.isError || /^(git_|open_pull_request|comment_on_pull_request|write_file)/.test(name);
      const label = telling ? `${e.payload.isError ? "failed: " : "✓ "}${first}` : "tool result";
      d.append(el("summary", null, label), el("pre", null, e.payload.output));
      line("agent", `${time}${forWhom}`, d);
      break;
    }
  }
  $("log").scrollTop = $("log").scrollHeight;
}

// A link to an event in the log. Notes cite their sources this way, so a
// reader can check any claim against what actually happened.
function cite(seq) {
  const a = el("a", "cite", `#${seq}`);
  a.href = "#";
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    const target = $("log").querySelector(`[data-seq="${seq}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  });
  return a;
}

function withCitations(text) {
  const box = el("div", "prose");
  for (const part of text.split(/(\[#\d+\])/)) {
    const m = part.match(/^\[#(\d+)\]$/);
    box.append(m ? cite(Number(m[1])) : document.createTextNode(part));
  }
  return box;
}

function renderNote(e, time, reason) {
  const { for: who, sinceSeq, upToSeq, facts: f, text } = e.payload;
  const range = sinceSeq ? `#${sinceSeq + 1}–#${upToSeq}` : `up to #${upToSeq}`;
  const body = el("div", "msg");
  body.append(withCitations(text));

  // The facts come from the log itself, not from the model.
  const items = [];
  const item = (label, rows) => rows.length && items.push([label, rows]);
  item("Now", [[`${f.driver} is driving; the agent is ${f.agent}${f.pausedBy ? ` (paused by ${f.pausedBy})` : ""}`]]);
  item("Waiting for approval", f.pendingApprovals.map((a) => [`${a.tool} for ${a.requestedFor}: it ${a.reason}`, a.seq]));
  item("Suggestions waiting", f.pendingSuggestions.map((x) => [`${x.author}: “${x.text}”`, x.seq]));
  item("Instructions", f.instructions.map((x) => [`${x.author}: “${x.text}”`, x.seq]));
  item("Handoffs", f.handoffs.map((x) => [`${x.from} to ${x.to}`, x.seq]));
  item("Commits", f.commits.map((x) => [`${x.sha ? `${x.sha} ` : ""}${x.message}, by ${x.by}`, x.seq]));
  item("Pushes", f.pushes.map((x) => [`${x.branch}, by ${x.by}${x.approvedBy ? `, approved by ${x.approvedBy}` : ""}`, x.seq]));
  item("Pull requests", f.pullRequests.map((x) => [`${x.title}, by ${x.by}${x.url ? ` (${x.url})` : ""}`, x.seq]));
  item("Files changed", f.filesChanged.map((x) => [`${x.path}, last by ${x.by}`, x.seq]));
  item("Failed", f.failures.map((x) => [`${x.tool}: ${x.error}`, x.seq]));
  item("Denied", f.denials.map((x) => [`${x.tool}, by ${x.by}${x.reason ? `: ${x.reason}` : ""}`, x.seq]));
  const details = el("details", "facts");
  details.open = true;
  details.append(el("summary", null, "From the log"));
  const dl = el("dl");
  for (const [label, rows] of items) {
    dl.append(el("dt", null, label));
    for (const [t, seq] of rows) {
      const dd = el("dd", null, t);
      if (seq) dd.append(" ", cite(seq));
      dl.append(dd);
    }
  }
  details.append(dl);
  const since = el("div", "since");
  body.append(details, since);
  const label = reason === "asked" ? `Catch-up note for ${who}` : `Handoff note for ${who}`;
  line("note", `${label} · covers ${range} · ${time}`, body);
  s.notes.push({ upToSeq, since });
}

function describe(input) {
  return input?.path ?? input?.branch ?? input?.name ?? input?.title ?? JSON.stringify(input ?? {}).slice(0, 80);
}

// Buttons depend on who is driving now and on roles, so they are redrawn on every change.
function refresh() {
  const driving = s.driver === me;
  const driverHere = s.watchers.some((w) => w.userId === s.driver);
  const myRole = roleOf(me);
  const canSteer = myRole !== "viewer";
  $("watchers").replaceChildren(
    ...s.watchers.map((w) => {
      const role = roleOf(w.userId);
      const cls = `who ${role}${w.userId === me ? " me" : ""}${w.userId === s.driver ? " driver" : ""}`;
      const pill = el("span", cls, w.userId);
      if (role !== "member") pill.append(el("span", "role", ` · ${role}`));
      return pill;
    }),
  );
  $("driver").textContent = driving ? "You are driving" : `${s.driver} is driving`;
  $("my-role").textContent = `you: ${myRole}`;
  $("claim").hidden = driving || driverHere || !canSteer;
  $("pause").disabled = !canSteer;
  $("text").disabled = $("composer").querySelector("button").disabled = !canSteer;
  $("roles").hidden = myRole !== "maintainer";
  const people = [...new Set([...s.watchers.map((w) => w.userId), ...s.roles.keys()])].filter((u) => u !== me);
  const picked = $("role-user").value;
  $("role-user").replaceChildren(...people.map((u) => new Option(u, u)));
  if (people.includes(picked)) $("role-user").value = picked;
  $("role-btn").disabled = people.length === 0;
  $("pass").hidden = !driving;
  const others = s.watchers.map((w) => w.userId).filter((u) => u !== me);
  $("pass-to").replaceChildren(...others.map((u) => new Option(u, u)));
  $("pass-btn").disabled = others.length === 0;
  $("pause").hidden = Boolean(s.paused);
  $("resume").hidden = !s.paused || !driving;
  $("paused-by").textContent = s.paused ? `Paused by ${s.paused}` : "";
  $("text").placeholder = !canSteer
    ? "Viewers can watch but not steer"
    : driving ? "Tell the agent what to do" : `Suggest something to ${s.driver}`;

  for (const [seq, author] of s.queued) setActions(seq, "queued", author === me ? [["Withdraw", `events/${seq}/withdraw`]] : []);
  for (const [seq, author] of s.suggestions) {
    const acts = [];
    if (driving) acts.push(["Accept", `suggestions/${seq}/accept`], ["Dismiss", `suggestions/${seq}/dismiss`]);
    if (author === me) acts.push(["Withdraw", `events/${seq}/withdraw`]);
    setActions(seq, "pending", acts);
  }
  for (const [id, a] of s.approvals) {
    const canApprove = RANK[myRole] >= RANK[a.minRole] && (a.allowSelf || me !== a.requestedFor);
    const acts = [];
    if (canApprove) acts.push(["Approve", `approvals/${encodeURIComponent(id)}/approve`]);
    if (canApprove || me === a.requestedFor) {
      acts.push(["Deny", `approvals/${encodeURIComponent(id)}/deny`, () => ({ reason: prompt("Why? The agent will see this.") ?? "" })]);
    }
    setActions(a.seq, "waiting", acts);
  }
  // A note covers the log up to where it started. Say how much has
  // happened since, rather than let it pass for current.
  for (const n of s.notes) {
    const newer = s.workSeqs.filter((q) => q > n.upToSeq);
    n.since.replaceChildren();
    if (!newer.length) {
      n.since.textContent = "Nothing has happened since this note.";
      continue;
    }
    n.since.append(`${newer.length} event${newer.length === 1 ? "" : "s"} happened after this note, starting at `, cite(newer[0]), ".");
  }
  const missed = s.workSeqs.filter((q) => q > s.lastVisit).length;
  $("catch-up").textContent = s.lastVisit && missed ? `Catch me up (${missed} new since your last visit)` : "Catch me up";

  const waiting = s.approvals.size > 0 && !s.paused;
  $("working").hidden = !waiting && !agentBusy();
  $("working").textContent = waiting ? "Agent is waiting for an approval…" : "Agent is working…";
}

function setActions(seq, tag, actions) {
  const n = s.nodes.get(seq);
  if (!n) return;
  const meta = n.querySelector(".meta");
  meta.querySelector(".tag")?.remove();
  meta.querySelector(".actions")?.remove();
  meta.append(el("span", "tag", tag));
  if (!actions.length) return;
  const box = el("span", "actions");
  for (const [label, path, makeBody] of actions) {
    const b = el("button", null, label);
    b.type = "button";
    b.addEventListener("click", () => act(path, makeBody?.()));
    box.append(b);
  }
  meta.append(box);
}

// Read off the log: the agent has work whenever it isn't paused and the last
// thing in the log is something it hasn't answered yet.
function agentBusy() {
  const e = s.lastEvent;
  if (!e || s.paused) return false;
  if (s.queued.size) return true;
  if (e.type === "model_response") return e.payload.stopReason === "tool_use";
  return ["tool_started", "tool_finished"].includes(e.type);
}

await loadSessions().catch(() => {});
open();
