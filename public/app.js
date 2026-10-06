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
  };
}
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

$("new").addEventListener("click", async () => {
  if (!me) return alert("Enter your name first.");
  const title = prompt("What is this session about?");
  if (!title) return;
  const { id } = await api("/sessions", { method: "POST", body: JSON.stringify({ title }) });
  sessionId = id;
  await loadSessions();
  location.hash = id;
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

function open() {
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
      break;
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
          const arg = b.input?.path ?? JSON.stringify(b.input).slice(0, 80);
          line("agent", `agent${forWhom} · ${time}`, el("div", "tool", `→ ${b.name} ${arg}`));
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

// Buttons depend on who is driving now, so they are redrawn on every change.
function refresh() {
  const driving = s.driver === me;
  const driverHere = s.watchers.some((w) => w.userId === s.driver);
  $("watchers").replaceChildren(
    ...s.watchers.map((w) => el("span", `who${w.userId === me ? " me" : ""}${w.userId === s.driver ? " driver" : ""}`, w.userId)),
  );
  $("driver").textContent = driving ? "You are driving" : `${s.driver} is driving`;
  $("claim").hidden = driving || driverHere;
  $("pass").hidden = !driving;
  const others = s.watchers.map((w) => w.userId).filter((u) => u !== me);
  $("pass-to").replaceChildren(...others.map((u) => new Option(u, u)));
  $("pass-btn").disabled = others.length === 0;
  $("pause").hidden = Boolean(s.paused);
  $("resume").hidden = !s.paused || !driving;
  $("paused-by").textContent = s.paused ? `Paused by ${s.paused}` : "";
  $("text").placeholder = driving ? "Tell the agent what to do" : `Suggest something to ${s.driver}`;

  for (const [seq, author] of s.queued) setActions(seq, "queued", author === me ? [["Withdraw", `events/${seq}/withdraw`]] : []);
  for (const [seq, author] of s.suggestions) {
    const acts = [];
    if (driving) acts.push(["Accept", `suggestions/${seq}/accept`], ["Dismiss", `suggestions/${seq}/dismiss`]);
    if (author === me) acts.push(["Withdraw", `events/${seq}/withdraw`]);
    setActions(seq, "pending", acts);
  }
  $("working").hidden = !agentBusy();
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
  for (const [label, path] of actions) {
    const b = el("button", null, label);
    b.type = "button";
    b.addEventListener("click", () => act(path));
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
