// A deliberately small client: it renders the session log and nothing else.
// Everything a viewer sees comes from the event stream, so two windows on
// the same session always agree.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let me = params.get("as") ?? localStorage.getItem("me") ?? "";
let sessionId = location.hash.slice(1);
let source = null;
let lastEvent = null;

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

async function loadSessions() {
  const list = await api("/sessions");
  const sel = $("sessions");
  sel.length = 1;
  for (const s of list) sel.add(new Option(`${s.title} (${s.created_by})`, s.id));
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
  await loadSessions();
  location.hash = id;
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  await api(`/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
});

function open() {
  source?.close();
  $("log").replaceChildren();
  $("watchers").replaceChildren();
  lastEvent = null;
  const ready = Boolean(me && sessionId);
  $("text").disabled = $("composer").querySelector("button").disabled = !ready;
  if (!ready) {
    $("log").innerHTML = `<p class="empty">${me ? "Pick or start a session." : "Enter your name to join."}</p>`;
    return;
  }
  // after=0 replays the whole log first, so joining late looks the same as
  // having been here all along. EventSource resumes by Last-Event-ID itself.
  source = new EventSource(`/sessions/${sessionId}/stream?after=0&as=${encodeURIComponent(me)}`);
  source.addEventListener("session_event", (m) => render(JSON.parse(m.data)));
  source.addEventListener("presence", (m) => renderWatchers(JSON.parse(m.data)));
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function line(cls, meta, body) {
  const n = el("div", `ev ${cls}`);
  n.append(el("div", "meta", meta), body);
  $("log").append(n);
}

function render(e) {
  lastEvent = e;
  const time = new Date(e.createdAt).toLocaleTimeString();
  const forWhom = e.onBehalfOf ? ` · for ${e.onBehalfOf}` : "";
  switch (e.type) {
    case "session_created":
      line("system", time, el("div", "meta", `${e.actor} started “${e.payload.title}”`));
      break;
    case "user_message":
      line("human", `${e.actor} · ${time}`, el("div", "msg", e.payload.text));
      break;
    case "model_response":
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
  $("working").hidden = !agentBusy();
  $("log").scrollTop = $("log").scrollHeight;
}

// Read off the log: the agent has work whenever the last thing in it is
// something it hasn't answered yet.
function agentBusy() {
  if (!lastEvent) return false;
  if (lastEvent.type === "model_response") return lastEvent.payload.stopReason === "tool_use";
  return ["user_message", "tool_started", "tool_finished"].includes(lastEvent.type);
}

function renderWatchers(list) {
  $("watchers").replaceChildren(
    ...list.map((w) => el("span", `who${w.userId === me ? " me" : ""}`, w.userId)),
  );
}

await loadSessions().catch(() => {});
open();
