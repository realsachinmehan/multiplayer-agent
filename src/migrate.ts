import { connect, migrate } from "./db.js";

const db = connect();
await migrate(db);
await db.end();
console.log("migrated");
