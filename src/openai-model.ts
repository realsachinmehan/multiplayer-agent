import type Anthropic from "@anthropic-ai/sdk";
import type { Model, ModelRequest, ModelResponse } from "./model.js";

// The rest of the app speaks Anthropic's message shapes: they are what the
// event log stores and what state.fold rebuilds. This adapter translates at
// the edge, so a session's log looks the same whichever provider wrote it.

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ChatResponse = {
  choices: { finish_reason: string | null; message: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
};

/** Any endpoint that speaks the OpenAI Chat Completions API with tool calling. */
export class OpenAICompatModel implements Model {
  constructor(
    private opts: { baseUrl: string; apiKey: string; model: string; maxTokens?: number; retries?: number },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async next(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.opts.model,
      max_completion_tokens: this.opts.maxTokens ?? 8192,
      messages: toChatMessages(req),
      ...(req.tools.length ? { tools: req.tools.map(toChatTool) } : {}),
    };
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const retries = this.opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
      });
      if (res.ok) return fromChatResponse((await res.json()) as ChatResponse);
      // Rate limits and server errors are worth another try; anything else
      // (a bad key, an unknown model, a malformed request) will not change.
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`${this.opts.model} returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
  }
}

function toChatTool(t: Anthropic.Beta.BetaTool) {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema, ...(t.strict ? { strict: true } : {}) },
  };
}

export function toChatMessages(req: ModelRequest): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as ChatMessage);
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = m.content.flatMap((b): ChatToolCall[] =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
          : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn leads with the results of the previous turn's calls. Chat
    // Completions wants each as its own "tool" message, straight after the
    // assistant message that made the call, then any text as a user message.
    const text: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${content}` : content });
      } else if (b.type === "text") {
        text.push(b.text);
      }
    }
    if (text.length) out.push({ role: "user", content: text.join("\n\n") });
  }
  return out;
}

const STOP_REASONS: Record<string, string> = { tool_calls: "tool_use", stop: "end_turn", length: "max_tokens" };

export function fromChatResponse(res: ChatResponse): ModelResponse {
  const choice = res.choices[0];
  if (!choice) throw new Error("the model returned no choices");
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  // Some reasoning models leak their thinking into the reply, ending it with
  // a bare </think>. Only what follows is meant for the people watching.
  const text = (choice.message.content ?? "").split("</think>").at(-1)!.trim();
  if (text) content.push({ type: "text", text, citations: null });
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      // The tool rejects the missing arguments and the model sees why.
      input = {};
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input } as Anthropic.Beta.BetaToolUseBlock);
  }
  // Some providers say "stop" even when they made calls; the calls decide.
  const finish = choice.finish_reason ?? "stop";
  const stopReason = finish === "length" ? "max_tokens" : content.some((b) => b.type === "tool_use") ? "tool_use" : (STOP_REASONS[finish] ?? finish);
  return { content, stopReason };
}
