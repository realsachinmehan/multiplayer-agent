import { describe, expect, it } from "vitest";
import { modelFromEnv } from "../src/model.js";
import { fromChatResponse, OpenAICompatModel, toChatMessages } from "../src/openai-model.js";

const tool = {
  name: "read_file",
  description: "Read a file.",
  input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
};

describe("OpenAI-compatible provider", () => {
  it("turns a tool round trip into chat messages in the order the API expects", () => {
    const messages = toChatMessages({
      system: "be useful",
      tools: [tool],
      messages: [
        { role: "user", content: [{ type: "text", text: "[alice] read the README" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading it." },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "no such file", is_error: true },
            { type: "text", text: "[bob, accepted by alice] try docs/ too" },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      { role: "system", content: "be useful" },
      { role: "user", content: "[alice] read the README" },
      {
        role: "assistant",
        content: "Reading it.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Error: no such file" },
      { role: "user", content: "[bob, accepted by alice] try docs/ too" },
    ]);
  });

  it("reads tool calls back as tool_use blocks, whatever finish reason the provider gives", () => {
    const res = fromChatResponse({
      choices: [
        {
          finish_reason: "stop",
          message: { content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
        },
      ],
    });
    expect(res.stopReason).toBe("tool_use");
    expect(res.content).toEqual([{ type: "tool_use", id: "c9", name: "read_file", input: { path: "a.ts" } }]);

    expect(fromChatResponse({ choices: [{ finish_reason: "stop", message: { content: "done" } }] })).toEqual({
      content: [{ type: "text", text: "done", citations: null }],
      stopReason: "end_turn",
    });
    const leaked = fromChatResponse({ choices: [{ finish_reason: "stop", message: { content: "Wait, let me think. </think> Fixed it." } }] });
    expect(leaked.content).toEqual([{ type: "text", text: "Fixed it.", citations: null }]);
    // A cut-off turn stays cut off, so its half-written call never runs.
    const cut = fromChatResponse({
      choices: [{ finish_reason: "length", message: { tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"pa' } }] } }],
    });
    expect(cut.stopReason).toBe("max_tokens");
  });

  it("sends the key as a bearer token, retries server errors, and reports the rest", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const replies = [
      new Response("busy", { status: 503 }),
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] }),
      new Response("bad model", { status: 400 }),
    ];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return replies.shift()!;
    }) as typeof fetch;
    const model = new OpenAICompatModel({ baseUrl: "https://llm.example/v1/", apiKey: "k", model: "m" }, fake);
    const req = { system: "s", tools: [], messages: [{ role: "user" as const, content: "hello" }] };

    expect((await model.next(req)).content).toEqual([{ type: "text", text: "hi", citations: null }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://llm.example/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("tools");

    await expect(model.next(req)).rejects.toThrow("m returned 400: bad model");
  });

  it("is chosen by MODEL_PROVIDER and refuses to start half-configured", () => {
    expect(modelFromEnv({ MODEL_PROVIDER: "openai", OPENAI_BASE_URL: "u", OPENAI_API_KEY: "k", MODEL: "m" })).toBeInstanceOf(OpenAICompatModel);
    expect(() => modelFromEnv({ MODEL_PROVIDER: "openai", OPENAI_BASE_URL: "u" })).toThrow("needs OPENAI_API_KEY, MODEL");
  });
});
