import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Db } from "./db.js";
import { readEvents } from "./events.js";
import { Hub } from "./hub.js";
import * as presence from "./presence.js";
import { createSession, postMessage } from "./sessions.js";

export type ServerOpts = {
  port?: number;
  // How often an open stream refreshes its presence row and sends a keepalive.
  heartbeatMs?: number;
  // A presence row lives this long without a heartbeat.
  presenceTtlMs?: number;
};

export type RunningServer = { url: string; hub: Hub; close(): Promise<void> };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const USER_ID = /^[A-Za-z0-9_.-]{1,32}$/;
const PUBLIC = join(import.meta.dirname, "..", "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const MIME: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css" };

/**
 * Who is making the request. A stand-in until real auth: the caller names
 * themselves with ?as=<user> (EventSource can't send headers) or X-User.
 */
function identify(req: http.IncomingMessage, url: URL): string {
  const user = url.searchParams.get("as") ?? req.headers["x-user"];
  if (typeof user !== "string" || !USER_ID.test(user)) {
    throw new HttpError(401, "say who you are with ?as=<name>");
  }
  return user;
}

async function body(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new HttpError(413, "body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
}

async function sessionExists(db: Db, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const { rowCount } = await db.query("SELECT 1 FROM sessions WHERE id = $1", [id]);
  return rowCount === 1;
}

export async function startServer(db: Db, opts: ServerOpts = {}): Promise<RunningServer> {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const ttlMs = opts.presenceTtlMs ?? heartbeatMs * 3;
  const hub = new Hub(db);
  await hub.start();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      json(res, 500, { error: "internal error" });
    }
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const path = url.pathname;

    if (req.method === "GET" && STATIC[path]) {
      const file = STATIC[path];
      const text = await readFile(join(PUBLIC, file), "utf8");
      return void res.writeHead(200, { "content-type": MIME[file.split(".").pop()!] }).end(text);
    }

    if (path === "/sessions" && req.method === "GET") {
      const { rows } = await db.query(
        "SELECT id, title, created_by, status, created_at FROM sessions ORDER BY created_at DESC LIMIT 50",
      );
      return json(res, 200, rows);
    }

    if (path === "/sessions" && req.method === "POST") {
      const user = identify(req, url);
      const { title } = await body(req);
      if (typeof title !== "string" || !title.trim()) throw new HttpError(400, "title is required");
      return json(res, 201, { id: await createSession(db, { title: title.trim(), createdBy: user }) });
    }

    const m = path.match(/^\/sessions\/([^/]+)\/(messages|events|stream)$/);
    if (!m) throw new HttpError(404, "not found");
    const [, sessionId, what] = m;
    if (!(await sessionExists(db, sessionId))) throw new HttpError(404, "no such session");

    if (what === "messages" && req.method === "POST") {
      const user = identify(req, url);
      const { text } = await body(req);
      if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text is required");
      const e = await postMessage(db, sessionId, user, text.trim());
      return json(res, 201, { seq: e.seq });
    }

    if (what === "events" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 500) || 500, 500);
      return json(res, 200, await readEvents(db, sessionId, after, limit));
    }

    if (what === "stream" && req.method === "GET") {
      return stream(req, res, url, sessionId);
    }

    throw new HttpError(405, "method not allowed");
  }

  /**
   * Server-sent events. Each session event goes out with id: <seq>, so a
   * browser's EventSource resumes from the right place on reconnect via the
   * Last-Event-ID header. Presence snapshots carry no id and don't move it.
   */
  async function stream(req: http.IncomingMessage, res: http.ServerResponse, url: URL, sessionId: string) {
    const user = identify(req, url);
    const lastId = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
    const after = Number(lastId) || 0;
    const connectionId = randomUUID();

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");

    let closed = false;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      unsubscribe();
      void presence.leave(db, connectionId).catch(() => {});
      res.end();
    };
    const beat = setInterval(() => {
      res.write(": ping\n\n");
      void presence.heartbeat(db, connectionId, ttlMs).catch(() => {});
    }, heartbeatMs);
    req.on("close", close);

    unsubscribe = await hub.subscribe(sessionId, after, {
      event: (e) => res.write(`id: ${e.seq}\nevent: session_event\ndata: ${JSON.stringify(e)}\n\n`),
      presence: (w) => res.write(`event: presence\ndata: ${JSON.stringify(w)}\n\n`),
      fail: close,
    });
    if (closed) return unsubscribe();
    // Join after subscribing, so this client also receives the presence
    // change its own arrival causes.
    await presence.join(db, connectionId, sessionId, user, ttlMs);
    // The client may have gone while we were inserting.
    if (closed) await presence.leave(db, connectionId);
  }

  const sweep = setInterval(() => void presence.sweepExpired(db).catch(() => {}), heartbeatMs);

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://localhost:${port}`,
    hub,
    async close() {
      clearInterval(sweep);
      await hub.stop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
