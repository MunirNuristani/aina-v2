// Creates the first user, a board with a fresh secret key, and its sensors (S1..S4 on channels 1..4).
// Prints the board id and key ONCE. Only the key's SHA-256 hash is stored, so a lost key can't be recovered, only rotated.
//
//   npm run bootstrap -- --user "Munir" --board "Windowsill board" [--channels 4]
//   npm run bootstrap -- --rotate <board-uuid>          # new key for an existing board
//
// Reads DATABASE_URL from web/.env.local (npm run bootstrap passes --env-file).
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Put it in web/.env.local");
  process.exit(1);
}

const newKey = () => randomBytes(32).toString("base64url"); // 256 random bits, URL/header safe
const hash = (k) => createHash("sha256").update(k, "utf8").digest();

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const rotate = arg("rotate");
  if (rotate) {
    const key = newKey();
    const r = await client.query(
      "update boards set key_hash = $2, key_created_at = now() where id = $1 returning id, name",
      [rotate, hash(key)],
    );
    if (r.rowCount === 0) throw new Error(`no board with id ${rotate}`);
    console.log(`\nNew key for board "${r.rows[0].name}" (${rotate}). The old key stops working immediately.`);
    console.log(`BOARD_KEY=${key}\n`);
  } else {
    const userName = arg("user");
    const boardName = arg("board");
    const channels = Number(arg("channels") ?? "4");
    if (!userName || !boardName || !Number.isInteger(channels) || channels < 1 || channels > 16) {
      console.error('usage: npm run bootstrap -- --user "Name" --board "Board name" [--channels 4]');
      process.exit(1);
    }
    const key = newKey();
    await client.query("begin");
    const u = await client.query("insert into users (name) values ($1) returning id", [userName]);
    const userId = u.rows[0].id;
    const b = await client.query(
      "insert into boards (owner_id, name, key_hash) values ($1, $2, $3) returning id",
      [userId, boardName, hash(key)],
    );
    const boardId = b.rows[0].id;
    for (let ch = 1; ch <= channels; ch++) {
      await client.query(
        "insert into sensors (owner_id, board_id, channel, label) values ($1, $2, $3, $4)",
        [userId, boardId, ch, `S${ch}`],
      );
    }
    await client.query("commit");
    console.log("\nCreated. Save these now; the key is NOT stored and cannot be shown again.");
    console.log(`USER_ID=${userId}`);
    console.log(`BOARD_ID=${boardId}`);
    console.log(`BOARD_KEY=${key}\n`);
  }
} catch (err) {
  await client.query("rollback").catch(() => {});
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
