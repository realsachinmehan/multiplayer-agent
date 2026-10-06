import { connect } from "./db.js";
import { startServer } from "./server.js";

const db = connect();
const server = await startServer(db, { port: Number(process.env.PORT ?? 3000) });
console.log(`listening on ${server.url}`);
