import type Anthropic from "@anthropic-ai/sdk";
import type { SessionEvent } from "./events.js";

type Message = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type UserBlock = Anthropic.Beta.BetaContentBlockParam;

export type NextAction =
  | { kind: "idle" }
  | { kind: "call_model" }
  // A tool the model asked for that hasn't finished. resumed is true when a
  // previous worker logged tool_started and then died before tool_finished.
  | { kind: "run_tool"; toolUse: ToolUse; resumed: boolean };

/** An instruction on the log that the agent hasn't read yet. */
export type Queued = { seq: number; text: string; author: string; suggestedBy?: string };
export type Suggestion = { seq: number; text: string; author: string };

export type SessionState = {
  lastSeq: number;
  // The conversation as the model has seen it, plus anything pending that the
  // next model call would include. Rebuilt from the log on every step.
  messages: Message[];
  next: NextAction;
  // The human whose instruction the agent is currently serving: the author of
  // the latest instruction the model has seen or is about to see.
  steerer: string | null;
  driver: string | null;
  paused: boolean;
  queued: Queued[];
  suggestions: Suggestion[];
};

/**
 * Folds a session's events into the state the agent loop acts on. Pure and
 * deterministic, so a worker resuming after a crash, a command checking what
 * is allowed, and a client replaying the log all get the same answer.
 *
 * Ordering rule: an instruction only enters the conversation at the first
 * model call that saw it (seq <= basedOnSeq). One that arrived while the
 * model was mid-call sits in the log before that model_response, but is
 * placed after it, because that is when the model actually read it.
 */
export function fold(events: SessionEvent[]): SessionState {
  const messages: Message[] = [];
  let queued: Queued[] = [];
  const suggestions = new Map<number, Suggestion>();
  let toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  let openToolUses: ToolUse[] = [];
  const started = new Set<string>();
  let steerer: string | null = null;
  let driver: string | null = null;
  let paused = false;
  let lastSeq = 0;

  const flushUserTurn = (upToSeq: number) => {
    const seen = queued.filter((q) => q.seq <= upToSeq);
    queued = queued.filter((q) => q.seq > upToSeq);
    // Tool results must lead the user turn that follows a tool_use turn.
    const content: UserBlock[] = [...toolResults, ...seen.map(textBlock)];
    toolResults = [];
    if (seen.length) steerer = seen[seen.length - 1].author;
    if (content.length) messages.push({ role: "user", content });
  };
  const toolError = (t: ToolUse, content: string) => {
    toolResults.push({ type: "tool_result", tool_use_id: t.id, content, is_error: true });
  };

  for (const e of events) {
    lastSeq = e.seq;
    switch (e.type) {
      case "session_created":
        driver = e.actor;
        break;
      case "user_message":
        queued.push({ seq: e.seq, text: e.payload.text, author: e.actor, suggestedBy: e.payload.suggestedBy });
        if (e.payload.suggestionSeq != null) suggestions.delete(e.payload.suggestionSeq);
        break;
      case "suggestion":
        suggestions.set(e.seq, { seq: e.seq, text: e.payload.text, author: e.actor });
        break;
      case "suggestion_dismissed":
        suggestions.delete(e.payload.suggestionSeq);
        break;
      case "withdrawn":
        queued = queued.filter((q) => q.seq !== e.payload.targetSeq);
        suggestions.delete(e.payload.targetSeq);
        break;
      case "driver_changed":
        driver = e.payload.to;
        break;
      case "paused":
        paused = true;
        // Calls the model planned but no worker has started are cancelled.
        // One already running finishes and reports; it is never cut off.
        for (const t of openToolUses.filter((t) => !started.has(t.id))) {
          toolError(t, `not run: ${e.actor} paused the session before this started`);
        }
        openToolUses = openToolUses.filter((t) => started.has(t.id));
        break;
      case "resumed":
        paused = false;
        break;
      case "model_response":
        flushUserTurn(e.payload.basedOnSeq);
        messages.push({ role: "assistant", content: e.payload.content as Anthropic.Beta.BetaContentBlockParam[] });
        openToolUses = e.payload.content.filter((b): b is ToolUse => b.type === "tool_use");
        started.clear();
        // A turn cut off at max_tokens can hold a half-written call that must
        // not run. It still needs a result, or the API rejects the history.
        if (e.payload.stopReason !== "tool_use") {
          for (const t of openToolUses) toolError(t, "not run: your response was cut off");
          openToolUses = [];
        }
        break;
      case "tool_started":
        started.add(e.payload.toolUseId);
        break;
      case "tool_finished":
        toolResults.push({
          type: "tool_result",
          tool_use_id: e.payload.toolUseId,
          content: e.payload.output,
          is_error: e.payload.isError,
        });
        openToolUses = openToolUses.filter((t) => t.id !== e.payload.toolUseId);
        break;
    }
  }

  let next: NextAction;
  if (openToolUses.length) {
    const t = openToolUses[0];
    next = { kind: "run_tool", toolUse: t, resumed: started.has(t.id) };
  } else if (paused) {
    next = { kind: "idle" };
  } else if (toolResults.length || queued.length) {
    next = { kind: "call_model" };
  } else {
    next = { kind: "idle" };
  }

  const pending = [...queued];
  // Show the pending turn as the next model call would send it.
  if (next.kind === "call_model") flushUserTurn(lastSeq);

  return { lastSeq, messages, next, steerer, driver, paused, queued: pending, suggestions: [...suggestions.values()] };
}

function textBlock(q: Queued): Anthropic.Beta.BetaTextBlockParam {
  // Several people talk to the same agent, so each instruction says who it
  // came from, and who approved it if it started as a suggestion.
  const who = q.suggestedBy ? `${q.suggestedBy}, accepted by ${q.author}` : q.author;
  return { type: "text", text: `[${who}] ${q.text}` };
}
