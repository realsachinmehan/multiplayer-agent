# multiplayer-agent

A coding agent session that several engineers can watch, steer and hand off, like a teammate. Built as an answer to YC's Fall 2026 "Multiplayer AI" request.

The angle: **the agent acts as whoever steered it.** Every action records the human whose instruction caused it, and acts on it: a commit the agent makes while Bob is steering is authored by Bob, with Bob's token, and a push to main waits for a maintainer who isn't Bob. Shipping products like Cursor's shared cloud agents run every follow-up on the session creator's credentials.

## Status

Steps 1 to 5 of 6 are built: a durable agent loop on an append-only event log, streamed live to everyone watching, with rules for who steers it, whose name its actions carry, and a note for whoever takes over.

| Step | What | State |
|---|---|---|
| 1 | Durable agent loop + append-only Postgres event log | done |
| 2 | Live fan-out to clients (SSE), presence, late-join replay | done |
| 3 | Driver role, suggestions, pause, withdrawal, conflict tests | done |
| 4 | Per-steerer identity on commits and PR comments, role-scoped approvals | done |
| 5 | Handoff summaries | done |
| 6 | Two-window demo and conflict write-up | next |

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

**Steering rules.** Several people talking to one agent at once is the core design problem. The rules are in `src/commands.ts`:

- **One driver at a time.** The session's creator drives first. The driver's messages are instructions; everyone else's are suggestions that show up for all to see, and the agent only acts on one once the driver accepts it. An accepted suggestion reaches the model as `[bob, accepted by alice] ...` and runs with Alice's authority.
- **Handoff.** The driver can pass the wheel to anyone, and anyone can take it once the driver has left the session. Instructions the old driver queued that the agent hasn't read yet are withdrawn, because they carried the old driver's authority. Pending suggestions carry over to the new driver.
- **Pause.** Anyone can pause. A tool that is already running finishes and reports, because cutting it off mid-side-effect is worse, and tool calls that haven't started are cancelled. Only the driver can resume.
- **Withdraw.** You can take back your own instruction until the agent reads it, or your own suggestion until it's resolved.

Two mechanisms make these hold under concurrency:

1. **Commands are decided under the session's row lock.** Each one locks the session, folds the log as it stands, checks the rules and appends in the same transaction. If Alice sends an instruction at the same instant she hands the wheel to Bob, one of them commits first and the other is judged against it: the instruction either lands first and the handoff withdraws it, or lands second and is only a suggestion.
2. **The agent's steps are compare-and-swap.** A model call can take minutes, and in that time someone may pause, hand off or withdraw the very instruction the model is answering. Each of those bumps the session's `control_seq`. A model response or tool start is committed only if `control_seq` hasn't moved past what the step was planned from; otherwise it's discarded and the worker re-plans from the log. New messages don't count: they simply queue for the next step. Model calls have no side effects, so throwing one away is always safe.

**Attribution.** Every event has `actor` (who wrote it: a user id or `agent`) and `on_behalf_of` (the human whose instruction the agent was serving). Tool code receives `onBehalfOf`, and acts as that person.

**Acting as the steerer.** Each person connects their own GitHub account once (`PUT /me/github`); the token is encrypted with AES-256-GCM under `CREDENTIALS_KEY` and never leaves the server, never enters the log and never reaches the model. When the agent commits, pushes, opens a PR or comments, it uses the credentials of the person it is acting for, and nobody else's:

- commits are **authored** by the steerer and **committed** by `Multiplayer Agent <agent@multiplayer-agent.invalid>`, with `Agent-Session:` and, when one was needed, `Approved-By:` trailers. The history says who asked for the change and that a machine made it.
- pushes and GitHub API calls go out with the steerer's token. Git gets it through the environment, never argv, and anything git prints is scrubbed before it is logged.
- if the steerer hasn't connected an account, the call fails and says so. There is no fallback to the session creator's token: borrowing someone else's identity is the thing this project exists to avoid.

**Roles and approval gates.** Everyone in a session is a `viewer`, `member` or `maintainer`; the creator is a maintainer and anyone else is a member unless a maintainer says otherwise. Viewers can watch but not steer. A tool can declare that a particular call needs sign-off, as `git_push` does for the repository's default branch:

```ts
approval({ branch }, { defaultBranch }) {
  return branch === defaultBranch
    ? { minRole: "maintainer", allowSelf: false, reason: `pushes straight to ${defaultBranch}` }
    : null;
}
```

The worker appends `approval_requested` instead of running the call, and it sits there until someone decides. `allowSelf: false` means the person who steered cannot approve their own push, so a push to main always takes two people. Roles are checked when the approval is *granted*, not when it is requested, so demoting someone mid-flight takes effect. A denial reaches the model as the tool's result, with the reason, so the agent can try another way. Pausing cancels pending approvals along with the calls they belong to, and a decision is taken under the session row lock, so an approve and a deny racing each other resolve to exactly one.

**Handoff notes.** Whoever takes the wheel gets a note, asked for in the same transaction as the handoff so none is ever missed, and anyone can ask for one with **Catch me up**. A note has two parts that are kept apart on purpose:

- **Facts, computed from the log**: who is driving and what the agent is doing, approvals and suggestions waiting, instructions, handoffs, commits, pushes, PRs, files changed, failures and denials, each linked to the event it came from. No model is involved, so these are exact.
- **A short narrative from the model**: goal, done, in flight, watch out for. It must cite the events it relies on as `[#12]`, and any citation to an event the note never saw is removed before it is stored, so every link in a note goes somewhere real.

A returning driver's note covers what happened since they last held the wheel; a catch-up covers what happened since that browser's last visit. If nothing happened, the note says so without calling the model.

Notes are written while the agent keeps working, which is the case the plan flagged as hard. They are written by the worker beside the agent loop, not inside it: a note takes its own claim (`summary_claims`) instead of the session lease, so the agent never waits for it, and it never counts as a control event, so a note landing mid-model-call never makes the agent throw that call away. Each note records `upToSeq`, the last event it read, and the client shows how much has happened since ("5 events happened after this note, starting at #17") instead of letting a note pass for current. Notes stay out of the agent's own conversation. Two workers racing for the same request produce one note: the claim keeps the second from calling the model, and the append checks under the session lock that no note exists yet. A worker that dies mid-note lets its claim expire, and a model failure is recorded as `summary_failed` rather than retried forever.

## Run it

Needs Node 22+ and Postgres 16.

```sh
npm install
createdb mpagent && createdb mpagent_test
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/mpagent
export CREDENTIALS_KEY=$(openssl rand -hex 32)   # encrypts people's GitHub tokens
npm run migrate
npm test

# Try it with Claude (needs ANTHROPIC_API_KEY):
npm run worker &
npm run server &
open "http://localhost:3000/?as=alice"   # start a session here
open "http://localhost:3000/?as=bob"     # pick the same session here
```

There is no login yet: `?as=<name>` says who you are, and that name is the identity everything else hangs off. Each person clicks **Connect GitHub** once and pastes a personal access token; after that the agent acts as whoever is steering. Without `CREDENTIALS_KEY` the server refuses to store tokens, and the git and GitHub tools refuse to act.

A session can name a repository (`repoUrl` when you create one); the agent clones it as the person steering, or works in a fresh local repository if you leave it blank.

The CLI still works without the browser: `npm run cli new alice "title"`, `npm run cli say <session> bob "text"`, `npm run cli log <session>`.

The agent works in `workspaces/<session-id>/` with `list_files`, `read_file` and `write_file` (paths confined to that directory), plus `git_status`, `git_create_branch`, `git_commit`, `git_push`, `open_pull_request` and `comment_on_pull_request`.

## Tests

Everything runs against a real Postgres, with a scripted model in place of Claude.

`test/steering.test.ts`, the conflict cases:

- a non-driver's message is a suggestion the model never sees until the driver accepts it
- an accept, a dismiss and a second accept racing on one suggestion: exactly one applies
- only the driver can accept, dismiss, pass or resume; anyone can pause
- a handoff withdraws the old driver's unread instructions and keeps pending suggestions
- a model turn planned before a handoff, a pause or a withdrawal is discarded
- an instruction sent at the same moment as a handoff never reaches the agent with the old driver's authority (20 races)
- two people claiming an abandoned wheel at once: one wins; nobody can claim while the driver is present
- a pause lets the running tool finish, cancels the rest, and nothing runs until the driver resumes
- an instruction can be withdrawn until the agent reads it, and not after
- three simulated people pause, resume, suggest, accept and hand off at random while the agent runs. The test checks that every instruction came from the driver of the moment, that no tool started while paused, and that the conversation is still one the API accepts. This test found a real race: a pause followed quickly by a resume could let a cancelled tool start anyway.

`test/loop.test.ts`, the agent loop:

- a tool loop runs to completion, and every agent event is attributed to the steerer
- a message sent while the model is thinking is queued for the next step, not lost or shown as seen
- a worker freezes mid-tool, a second worker takes over from the log alone, and the frozen worker's late write is rejected (idempotent and non-idempotent variants)
- 50 concurrent appends get dense, unique sequence numbers
- a worker whose lease was taken over cannot append
- replaying the log rebuilds exactly the conversation the model saw
- a tool call from a turn cut off at max_tokens is never run
- tool paths can't escape the workspace

`test/identity.test.ts`, identity and approvals, with a real git remote and a fake GitHub:

- a handoff mid-session means the next commit is authored by the new driver, against a real repository
- PRs and comments go out with the steerer's own token, never the session creator's
- the agent refuses to act for someone without credentials rather than borrowing another person's
- no token appears in the event log, in a tool's output or in the model's prompt, and the stored token is encrypted at rest
- a push to main waits: a member can't approve, the person who asked can't approve themselves, and a second maintainer's approval lets it through as the original steerer
- an approve and a deny racing each other apply exactly one decision (5 races)
- a denial reaches the model with its reason, and nothing is pushed
- pausing cancels a pending approval
- the approver's role is checked when they approve, not when the request was made
- a push to any other branch isn't gated
- the HTTP API enforces the same rules, and a server with no key refuses to store a token
- only maintainers change roles, the last maintainer can't be demoted, and viewers can watch but not steer

`test/handoff.test.ts`, handoff notes:

- every handoff (passed or claimed) asks for a note for the new driver in the same transaction; a returning driver's covers only what happened while they were away
- the note is written while the new driver sets the agent to work: the agent is not held up, the note covers exactly the log as it stood when it started, and everything after shows as newer
- a note landing while the model is mid-call doesn't make the agent discard that call
- notes never reach the agent's conversation
- one note per request: a second worker leaves a claimed request alone, an expired claim is taken over, and two writers past the claim still append once
- citations to events the note never saw are dropped
- the facts (commits by Alice then Bob, a push, a pending approval to main, Carol's suggestion) come from the log, whatever the model writes
- nothing happened means no model call; a failed note is recorded and can be asked for again; anyone, viewers included, can ask to catch up, and asking twice doesn't double up

`test/stream.test.ts`, streaming and presence over real HTTP:

- a late joiner gets the whole log and then live events, with no gaps or repeats
- a reconnecting client resumes after `Last-Event-ID`
- three watchers see the identical order while 30 messages from three people land at once
- a watcher on a second server process sees messages posted through the first
- a live agent run streams step by step, each step attributed
- presence updates when people arrive and leave, counts tabs, and drops watchers whose server died
