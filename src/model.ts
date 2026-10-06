import Anthropic from "@anthropic-ai/sdk";

export type ModelRequest = {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
};

export type ModelResponse = {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
};

/** The one thing the loop needs from a model. Tests swap in a scripted one. */
export interface Model {
  next(req: ModelRequest): Promise<ModelResponse>;
}

export class ClaudeModel implements Model {
  constructor(
    private client = new Anthropic(),
    private model = "claude-opus-5-5",
  ) {}

  async next(req: ModelRequest): Promise<ModelResponse> {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 64000,
      system: req.system,
      // Handoff notes call the model with no tools at all.
      ...(req.tools.length ? { tools: req.tools } : {}),
      messages: req.messages,
      output_config: { effort: "high" },
      // On a safety-classifier refusal the API retries on a fallback model
      // instead of returning an empty turn.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const msg = await stream.finalMessage();
    return { content: msg.content, stopReason: msg.stop_reason };
  }
}
