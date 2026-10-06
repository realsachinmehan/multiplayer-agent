import { connect } from "./db.js";
import { readEvents } from "./events.js";
import { postMessage } from "./commands.js";
import { createSession } from "./sessions.js";

// Usage:
//   cli new <user> <title>
//   cli say <session> <user> <text...>
//   cli log <session>
const [cmd, ...args] = process.argv.slice(2);
const db = connect();

if (cmd === "new") {
  console.log(await createSession(db, { createdBy: args[0], title: args.slice(1).join(" ") }));
} else if (cmd === "say") {
  const e = await postMessage(db, args[0], args[1], args.slice(2).join(" "));
  console.log(`#${e.seq}`);
} else if (cmd === "log") {
  for (const e of await readEvents(db, args[0])) {
    const who = e.onBehalfOf && e.onBehalfOf !== e.actor ? `${e.actor} for ${e.onBehalfOf}` : e.actor;
    console.log(`#${e.seq} ${e.type} (${who}) ${JSON.stringify(e.payload).slice(0, 160)}`);
  }
} else {
  console.error("usage: cli new <user> <title> | say <session> <user> <text> | log <session>");
  process.exitCode = 1;
}
await db.end();
