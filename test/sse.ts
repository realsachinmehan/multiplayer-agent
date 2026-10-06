/** A minimal server-sent-events client for tests, built on fetch. */
export type SseMessage = { event: string; id?: string; data: any };

export class SseClient {
  messages: SseMessage[] = [];
  private controller = new AbortController();
  private waiters: Array<() => void> = [];
  done: Promise<void>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.done = this.run(url, headers).catch((err) => {
      if (err.name !== "AbortError") throw err;
    });
  }

  private async run(url: string, headers: Record<string, string>) {
    const res = await fetch(url, { headers, signal: this.controller.signal });
    if (!res.ok) throw new Error(`stream failed: ${res.status} ${await res.text()}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body!) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        this.parse(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
  }

  private parse(block: string) {
    const msg: Partial<SseMessage> & { data?: string } = { event: "message" };
    let data: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith(":") || !line) continue;
      const [field, ...rest] = line.split(":");
      const value = rest.join(":").replace(/^ /, "");
      if (field === "event") msg.event = value;
      else if (field === "id") msg.id = value;
      else if (field === "data") data = data === undefined ? value : `${data}\n${value}`;
    }
    if (data === undefined) return;
    this.messages.push({ event: msg.event!, id: msg.id, data: JSON.parse(data) });
    for (const w of this.waiters.splice(0)) w();
  }

  events() {
    return this.messages.filter((m) => m.event === "session_event").map((m) => m.data);
  }

  seqs() {
    return this.events().map((e) => e.seq as number);
  }

  latestPresence(): string[] | undefined {
    const p = this.messages.filter((m) => m.event === "presence").at(-1);
    return p?.data.map((w: { userId: string }) => w.userId);
  }

  async until(pred: (c: SseClient) => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred(this)) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(this.messages).slice(0, 500)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  close() {
    this.controller.abort();
  }
}
