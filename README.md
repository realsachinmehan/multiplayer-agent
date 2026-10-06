# multiplayer-agent

A coding agent session that several engineers can watch, steer and hand off, like a teammate. Built as an answer to YC's Fall 2026 "Multiplayer AI" request.

The angle: **the agent acts as whoever steered it.** Every action records the human whose instruction caused it. Later steps use that to run commits and PR comments under that person's identity, and to scope approvals by role. Shipping products like Cursor's shared cloud agents run every follow-up on the session creator's credentials.

## Status

Steps 1 and 2 of 6 are built: a durable agent loop on an append-only event log, streamed live to everyone watching.

| Step | What | State |
|---|---|---|
| 1 | Durable agent loop + append-only Postgres event log | done |
| 2 | Live fan-out to clients (SSE), presence, late-join replay | done |
| 3 | Driver role, instruction queue, interrupt, two-user conflict tests | next |
| 4 | Per-steerer identity on commits and PR comments, role-scoped approvals | |
| 5 | Handoff summaries | |
| 6 | Two-window demo and conflict write-up | |

## How it works

**The log is the session.** Every user message, model response, tool start and tool result is a row in `events`, keyed by `(session_id, seq)`. Nothing updates or deletes rows. `fold()` in `src/state.ts` turns the log into the conversation and the agent's next action, and it is pure, so a worker resuming after a crash and a client replaying for a late joiner get the same answer.

**One worker per session, fenced.** A worker takes a lease on the session before acting. Each change of holder bumps an epoch, and every agent write carries that epoch and is checked under a row lock in the same transaction. A worker that froze and lost its lease cannot write, even if it wakes up mid-step.

**Each step is checkpointed.** A step reads the log, does one thing (call the model or run one tool), and appends the result. If the worker dies:

- during a model call: nothing was written, so the next worker asks again.
- after `tool_started` but before `tool_finished`: an idempotent tool runs again; a non-idempotent one is not re-run, and the model is told the outcome is unknown.

**Messages never interrupt a step; they queue.** Humans append `user_message` events at any time. Each `model_response` records `basedOnSeq`, the highest seq it saw. A message that landed while the model was mid-call is placed after that response in the conversation, because that's when the model actually reads it, and it triggers the next step. Each message reaches the model as `[author] text` so it knows who said what.

**Live to every watcher.** Clients follow a session over server-sent events. Every session event is sent with `id: <seq>`, and each connection keeps its own cursor and only ever sends the events after it, in order. So a late joiner (`after=0`) replays the whole log and then continues live, and a browser that drops its connection resumes from `Last-Event-ID` with no gaps and no repeats.

Fan-out uses Postgres `LISTEN/NOTIFY`, with no Redis. Each append sends a notification carrying only the session id, and every server process listening wakes its subscribers, which re-read the log from their cursor. The notification is just a doorbell and the log is the source of truth, so a lost notification costs latency, never correctness. Any number of server processes can serve the same session.

**Presence.** Each open stream holds a row in `presence` that it heartbeats. Watchers get a fresh snapshot (who, and how many tabs) whenever someone arrives or leaves. A server that dies without cleaning up leaves rows that expire, and the next sweep removes them and tells the session. Presence is kept out of the event log on purpose: it is live state, not session history.

**Attribution.** Every event has `actor` (who wrote it: a user id or `agent`) and `on_behalf_of` (the human whose instruction the agent was serving). Tool code receives `onBehalfOf`, which is where per-user credentials plug in later.

## Run it

Needs Node 22+ and Postgres 16.

```sh
npm install
createdb mpagent && createdb mpagent_test
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/mpagent
npm run migrate
npm test

# Try it with Claude (needs ANTHROPIC_API_KEY):
npm run worker &
npm run server &
open "http://localhost:3000/?as=alice"   # start a session here
open "http://localhost:3000/?as=bob"     # pick the same session here
```

There is no login yet: `?as=<name>` says who you are. Real identity arrives with step 4.

The CLI still works without the browser: `npm run cli new alice "title"`, `npm run cli say <session> bob "text"`, `npm run cli log <session>`.

The agent works in `workspaces/<session-id>/` with `list_files`, `read_file` and `write_file`, and paths are confined to that directory.

## Tests

Everything runs against a real Postgres, with a scripted model in place of Claude.

`test/loop.test.ts`, the agent loop:

- a tool loop runs to completion, and every agent event is attributed to the steerer
- a message sent while the model is thinking is queued for the next step, not lost or shown as seen
- a worker freezes mid-tool, a second worker takes over from the log alone, and the frozen worker's late write is rejected (idempotent and non-idempotent variants)
- 50 concurrent appends get dense, unique sequence numbers
- a worker whose lease was taken over cannot append
- replaying the log rebuilds exactly the conversation the model saw
- a tool call from a turn cut off at max_tokens is never run
- tool paths can't escape the workspace

`test/stream.test.ts`, streaming and presence over real HTTP:

- a late joiner gets the whole log and then live events, with no gaps or repeats
- a reconnecting client resumes after `Last-Event-ID`
- three watchers see the identical order while 30 messages from three people land at once
- a watcher on a second server process sees messages posted through the first
- a live agent run streams step by step, each step attributed
- presence updates when people arrive and leave, counts tabs, and drops watchers whose server died
