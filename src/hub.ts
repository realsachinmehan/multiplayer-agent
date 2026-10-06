import type pg from "pg";
import type { Db } from "./db.js";
import { EVENTS_CHANNEL, readEvents, type SessionEvent } from "./events.js";
import { PRESENCE_CHANNEL, watchers, type Watcher } from "./presence.js";

export type Sink = {
  event(e: SessionEvent): void;
  presence(w: Watcher[]): void;
  // Called when the stream cannot continue; the client reconnects and
  // resumes from its last seq.
  fail(err: unknown): void;
};

const PAGE = 500;

/**
 * One subscriber's view of a session's log. It only ever sends events in seq
 * order, starting after its cursor, so a late joiner and a reconnecting
 * client get the same treatment as a live one: no gaps and no repeats.
 * Wake-ups are coalesced; if one arrives mid-read, the read loops again.
 */
class Subscription {
  private reading = false;
  private again = false;
  closed = false;

  constructor(
    private db: Db,
    readonly sessionId: string,
    public cursor: number,
    readonly sink: Sink,
  ) {}

  async wake(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        for (;;) {
          const page = await readEvents(this.db, this.sessionId, this.cursor, PAGE);
          for (const e of page) {
            if (this.closed) return;
            this.sink.event(e);
            this.cursor = e.seq;
          }
          if (page.length < PAGE) break;
        }
      } while (this.again && !this.closed);
    } catch (err) {
      this.sink.fail(err);
    } finally {
      this.reading = false;
    }
  }
}

/**
 * Fans session events out to every client connected to this server process.
 * Each process holds one LISTEN connection, so any number of processes can
 * serve the same session and all of them hear every append.
 */
export class Hub {
  private subs = new Map<string, Set<Subscription>>();
  private listener?: pg.PoolClient;
  private stopped = false;

  constructor(private db: Db) {}

  async start(): Promise<void> {
    this.listener = await this.db.connect();
    this.listener.on("notification", (n) => {
      if (!n.payload) return;
      if (n.channel === EVENTS_CHANNEL) this.wakeSession(n.payload);
      else if (n.channel === PRESENCE_CHANNEL) void this.pushPresence(n.payload);
    });
    this.listener.on("error", () => void this.reconnect());
    await this.listener.query(`LISTEN ${EVENTS_CHANNEL}`);
    await this.listener.query(`LISTEN ${PRESENCE_CHANNEL}`);
  }

  /** After a dropped LISTEN connection, notifications may have been missed. */
  private async reconnect(): Promise<void> {
    this.listener?.release(true);
    this.listener = undefined;
    while (!this.stopped) {
      try {
        await this.start();
        for (const id of this.subs.keys()) {
          this.wakeSession(id);
          void this.pushPresence(id);
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async subscribe(sessionId: string, afterSeq: number, sink: Sink): Promise<() => void> {
    const sub = new Subscription(this.db, sessionId, afterSeq, sink);
    let set = this.subs.get(sessionId);
    if (!set) this.subs.set(sessionId, (set = new Set()));
    // Register before the first read: anything appended from here on either
    // shows up in that read or triggers another one.
    set.add(sub);
    await sub.wake();
    return () => {
      sub.closed = true;
      set.delete(sub);
      if (set.size === 0) this.subs.delete(sessionId);
    };
  }

  private wakeSession(sessionId: string): void {
    for (const sub of this.subs.get(sessionId) ?? []) void sub.wake();
  }

  async pushPresence(sessionId: string): Promise<void> {
    const set = this.subs.get(sessionId);
    if (!set?.size) return;
    const list = await watchers(this.db, sessionId);
    for (const sub of set) sub.sink.presence(list);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const set of this.subs.values()) for (const sub of set) sub.closed = true;
    this.subs.clear();
    this.listener?.release();
  }
}
