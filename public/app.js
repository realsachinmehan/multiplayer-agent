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

function open() {
  void loadMe().catch(() => {});
  source?.close();
  resetState();
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

function line(cls, meta, body, seq) {
  const n = el("div", `ev ${cls}`);
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
  s.lastEvent = e;
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
          line("agent", `agent${forWhom} · ${time}`, el("div", "tool", `→ ${b.name} ${describe(b.input)}`));
        }
      }
      break;
    case "tool_finished": {
      const d = el("details", `tool${e.payload.isError ? " error" : ""}`);
      d.append(el("summary", null, e.payload.isError ? "tool failed" : "tool result"), el("pre", null, e.payload.output));
      line("agent", `${time}${forWhom}`, d);
      break;
    }
  }
  $("log").scrollTop = $("log").scrollHeight;
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
    if (canApprove) acts.push(["Approve", `approvals/${id}/approve`]);
    if (canApprove || me === a.requestedFor) {
      acts.push(["Deny", `approvals/${id}/deny`, () => ({ reason: prompt("Why? The agent will see this.") ?? "" })]);
    }
    setActions(a.seq, "waiting", acts);
  }
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
