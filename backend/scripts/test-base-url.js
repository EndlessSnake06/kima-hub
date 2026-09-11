// Point DATABASE_URL at this checkout's own test base (kima_v1_test) so
// `prisma migrate deploy` brings the Jest template current -- same name-swap
// logic as src/__mocks__/test-db-defaults.cjs, without printing credentials.
const fs = require("fs");
const m = fs.readFileSync(".env", "utf8").match(/^DATABASE_URL=["']?([^"'\n]+)/m);
const u = new URL(m[1]);
u.pathname = "/kima_v1_test";
console.log(u.toString());
