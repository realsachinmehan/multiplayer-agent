# When several people steer one agent

A shared agent session is easy to demo and hard to get right. Several people act at once, the model takes seconds to minutes to answer, and tools change things in the world that can't be taken back. Every case below is something that happens in normal use, not an exotic failure. For each one this page says what goes wrong if you do nothing, the rule this project picked, how the code makes the rule hold, and which test proves it.

Everything rests on four mechanisms:

- **The log is the session.** Every message, model turn, tool call, approval and handoff is a row in an append-only `events` table with a dense per-session `seq`. All state is a pure fold over it, so a crashed worker, a late joiner and a command checking the rules all see the same thing.
- **Commands are decided under the session's row lock.** A person's action locks the session, folds the log as it stands, checks the rules and appends, all in one transaction. Two people acting at the same moment are applied one after the other, and the second is judged against the first.
- **The agent's steps are compare-and-swap.** A pause, handoff or withdrawal bumps `sessions.control_seq`. The agent commits a model turn, starts a tool or asks for approval only if `control_seq` hasn't moved since the log it planned from. Otherwise the step is discarded and the worker plans again. Model calls have no side effects, so throwing one away is always safe.
- **One worker per session, fenced.** A worker holds a lease with an epoch that goes up whenever the lease changes hands. Every agent write carries the epoch and is checked in the same transaction, so a worker that froze and lost its lease can't write when it wakes.

Test names below are from the `test/` directory; every test runs against a real Postgres.

## 1. Two people give the agent different instructions at the same time

**If nothing is done:** the agent gets "use Postgres" from Alice and "use SQLite" from Bob in one turn and picks one at random, or half-follows both.

**The rule:** one person drives. The driver's messages are instructions; everyone else's are suggestions that everyone can see and the agent can't. The agent only acts on a suggestion once the driver accepts it, and it then reads it as `[bob, accepted by alice] ...`, with Alice's authority. When the driver's own instructions conflict, the agent is told to say so rather than pick one silently.

**How it holds:** whether a message is an instruction is decided under the row lock from the driver *at that moment*. An accept and a dismiss racing on the same suggestion resolve to exactly one.

**Tested by:** `steering` › turns a non-driver's message into a suggestion the agent only sees once the driver accepts it; applies exactly one of an accept and a dismiss that race on the same suggestion; only lets the driver accept, dismiss, pass the wheel or resume.

## 2. A message arrives while the model is thinking

**If nothing is done:** the message is either lost (the worker never looks again) or shown to the model as if it had already been read, so the history says the model saw something it didn't.

**The rule:** messages never interrupt a step; they queue. Each model turn records `basedOnSeq`, the last event in its prompt. A message after that point is placed after the turn in the conversation, because that's when the model actually reads it, and it triggers the next step. A worker only goes idle if nothing arrived since its last read, so a message that lands in that gap still gets answered.

**Tested by:** `loop` › queues a message sent while the model is mid-call instead of losing it; does not go idle when a message lands between the last read and the idle check.

## 3. The driver changes while their instruction is still queued

**If nothing is done:** Alice queues "deploy it", hands the wheel to Bob, and the agent deploys on Alice's say-so while Bob is in charge.

**The rule:** an instruction carries the authority of its author at the moment the agent reads it. A handoff withdraws the old driver's instructions the agent hasn't read yet, and everyone sees them marked "dropped at handoff". Pending suggestions carry over, so the new driver can still accept them.

**How it holds:** the handoff and the withdrawals are one transaction. An instruction sent at the same instant as the handoff is serialized against it by the row lock: either it lands first and the handoff withdraws it, or it lands second and is only a suggestion. It never reaches the agent with authority Alice no longer has. If the model was already answering it, the handoff bumps `control_seq` and that answer is discarded.

**Tested by:** `steering` › withdraws the old driver's unread instructions when the wheel changes hands; never lets an instruction race past a handoff (20 races); discards a model turn that was planned before a handoff.

## 4. Someone hits pause during a long tool call

**If nothing is done:** either pause does nothing until the agent is finished, or it kills `npm install` or a migration halfway through.

**The rule:** anyone can pause; only the driver can resume. A tool that is already running finishes and reports, because cutting a side effect in half is worse than letting it end. Tool calls the model planned but no worker has started are cancelled, and the model is told who cancelled them. Instructions sent while paused queue up and run on resume.

**Tested by:** `steering` › lets a running tool finish, cancels the rest, and waits for the driver to resume; queues instructions sent while paused and runs them on resume.

## 5. The model's answer arrives after the world changed

**If nothing is done:** the model spends forty seconds answering an instruction. During that time someone pauses, hands off or withdraws the instruction. The answer comes back and the agent acts on it anyway.

**The rule:** an answer planned against a state that a person has since changed is thrown away, and the worker plans again from the log.

**How it holds:** compare-and-swap on `control_seq` for every agent write that matters: committing a model turn, starting a tool, requesting an approval. New messages don't bump it; they just queue (case 2). Handoff notes don't bump it either (case 12).

**Tested by:** `steering` › throws away a model turn that was in flight when someone paused; discards a model turn whose instruction was withdrawn while the model was thinking; discards a model turn that was planned before a handoff.

## 6. Pause and resume in quick succession

This one was found by a test, not by thinking about it.

**What went wrong:** the first version checked `paused` before starting a tool. A worker read the log and planned to start a tool. Someone paused, which cancelled the call, and then the driver resumed before the worker got to its check. `paused` was false again, so the cancelled tool started anyway, and the conversation now held two results for one call: the cancellation and the real one. The API rejects that history, so the session was stuck.

**The fix:** don't ask "is it paused now?", ask "has anything that changes what the agent should do happened since I planned?". The tool start compares `control_seq` instead of the `paused` flag, so the pause/resume pair invalidates the plan even though the flag ends up where it started.

**Tested by:** `steering` › keeps the agent's view consistent while three people pause, resume, suggest and hand off at random. Three simulated people act at random while the agent runs, and the test checks that every instruction came from the driver of the moment, that nothing started while paused, and that the conversation is still one the API accepts. It found the race above; after the fix it passed 150 runs in a row.

## 7. Two people try to take an abandoned wheel

**If nothing is done:** the driver closes their laptop, two teammates press "take the wheel" at once, and both believe they're driving.

**The rule:** you can claim the wheel only when the driver isn't present (no live presence row), and exactly one claim wins. You can't claim from a driver who is still there; ask them to pass it.

**Tested by:** `steering` › lets someone claim the wheel only when the driver has left, and only one claimer wins.

## 8. Approve and deny land at the same moment

**If nothing is done:** Carol approves a push to main while Dana denies it. The push happens, and the denial is also recorded and shown to the model.

**The rule:** a gated call waits as `approval_requested` until someone decides, and only the first decision counts. A denial reaches the model as the tool's result, with the reason, so it can try another way.

**How it holds:** decisions are commands, so they run under the row lock and the second one finds nothing pending.

**Tested by:** `identity` › applies exactly one decision when approve and deny race (5 races); tells the model who denied a call and why, and pushes nothing.

## 9. Who can approve, and when that's checked

**If nothing is done:** Bob asks the agent to push to main and approves it himself. Or Carol, demoted while the request sat there, approves it anyway.

**The rule:** a tool declares which calls need sign-off and from whom. `git_push` to the default branch needs a maintainer, and not the person who asked (`allowSelf: false`), so it always takes two people. The approver's role is checked when they approve, not when the request was made. A pause cancels pending approvals along with the calls they belong to.

**Tested by:** `identity` › holds a push to main until a second maintainer approves, then pushes as the steerer; checks the approver's role at the moment they approve; cancels a pending approval when someone pauses; enforces the same rules over HTTP; doesn't gate pushes to other branches.

## 10. The agent acts for someone who hasn't connected GitHub

**If nothing is done:** the agent borrows whichever token it has: usually the session creator's. Bob's change goes out as Alice. Cursor's shared cloud agents work this way today: every follow-up runs as whoever started the session. It's the problem this project is built around.

**The rule:** every side effect goes out under the credentials of the person whose instruction caused it, and nobody else's. Commits are authored by that person and committed by the agent. If they haven't connected an account, the call fails and says so. There is no fallback.

**Tested by:** `identity` › authors each commit as whoever was driving when it was asked for; opens PRs and comments with the steerer's own token, never the session creator's; refuses to act for someone without credentials instead of borrowing another person's; never writes a token into the event log or a tool's output.

## 11. A worker dies, or freezes and comes back

**If nothing is done:** a worker dies after starting `git commit` and before recording the result. A new worker either commits twice or never finds out what happened. Or a worker freezes long enough to lose its lease, wakes up, and writes into a session another worker now owns.

**The rule:** every step is checkpointed in the log. A tool that was started but not finished is re-run if it's idempotent (reading a file, pushing the same commit). If it isn't (committing, opening a PR), it isn't re-run, and the model is told the outcome is unknown. A worker that lost its lease can't write at all.

**Tested by:** `loop` › re-runs an idempotent tool that a dead worker had started; never re-runs a non-idempotent tool and tells the model the outcome is unknown; rejects agent writes from a worker whose lease was taken over; never runs a tool call from a turn that was cut off.

## 12. A handoff note is written while the agent keeps working

**If nothing is done:** either the agent stops while the note is written, which makes every handoff a pause, or the note describes a moving target and claims things it never saw.

**The rule:** notes are written beside the agent loop, not in it. A note takes its own claim instead of the session lease, and it isn't a control event, so the agent never waits for a note and never discards a step because one landed. A note covers the log as it stood when the note started (`upToSeq`). Whatever happened after is shown to the reader as newer than the note rather than folded into it. The note's summary must cite events by number, and citations to events it never saw are removed. The facts in a note are computed from the log, not written by the model.

**Tested by:** `handoff` › writes the note while the agent keeps working, and says exactly what it saw; never makes the agent throw away a step when a note lands mid-call; writes exactly one note per request, however many workers try; drops citations to events the note never saw; takes the facts from the log, not from the model.

## 13. Someone joins late, or their connection drops

**If nothing is done:** a late joiner sees only what happens from now on, and a reconnecting browser shows some events twice and misses others.

**The rule:** joining late looks the same as having been there all along. Every event is streamed with its `seq` as the SSE id, and each connection keeps its own cursor, so a late joiner replays from 0 and then continues live, and a reconnect resumes from `Last-Event-ID`. Postgres `LISTEN/NOTIFY` only rings a doorbell; the log is the source of truth, so a lost notification costs latency, never correctness.

**Tested by:** `stream` › replays the whole log to a late joiner, then continues live with no gaps or repeats; resumes after Last-Event-ID when a client reconnects; gives every watcher the same order while several people post at once; reaches watchers connected to a different server process.

## Not handled yet

- **A driver who is present but idle** keeps the wheel. The plan called for passing it on a timeout; this build only lets people claim it once the driver has left.
- **Contradictions inside accepted instructions** are left to the model to point out. Nothing detects them.
- **Identity is a stand-in.** People name themselves with `?as=`, and connect GitHub by pasting a token. Real sign-in (GitHub OAuth) would replace both.
- **Only pushes to the default branch are gated.** Running a migration or adding a dependency should be too; the approval hook is there, and those tools aren't.
- **A tool that is already running can't be stopped.** Pausing waits for it. That's deliberate for side effects, but it means a runaway test suite runs to the end.
