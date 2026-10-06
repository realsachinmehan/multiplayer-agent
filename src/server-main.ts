import { loadKey } from "./credentials.js";
import { connect } from "./db.js";
import { startServer } from "./server.js";

const db = connect();
const credentialsKey = process.env.CREDENTIALS_KEY ? loadKey() : undefined;
if (!credentialsKey) console.warn("CREDENTIALS_KEY is not set: nobody can connect GitHub, so git and GitHub tools will refuse to act");
const server = await startServer(db, { port: Number(process.env.PORT ?? 3000), credentialsKey });
console.log(`listening on ${server.url}`);
