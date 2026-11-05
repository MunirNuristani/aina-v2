import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { parsePayload } from "../src/lib/validate";
import { authenticateBoard, hashKey } from "../src/lib/auth";
import { INGEST_SQL, ingestBatch } from "../src/lib/ingest";
import { runInTransaction } from "../src/lib/tx";

const dbDir = path.resolve(__dirname, "../../db");
const BOARD = "00000000-0000-0000-0000-0000000000b1"; // from dev_seed.sql, key "dev-only-secret"
const NOW = Date.parse("2026-11-03T22:00:00Z");

let db: PGlite;
before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(dbDir, "migrations/0001_init.sql"), "utf8"));
  await db.exec(fs.readFileSync(path.join(dbDir, "seed/dev_seed.sql"), "utf8"));
  // a second board owned by the guest, with the same channel number 1, to prove boards can't cross-write
  await db.exec(`
    insert into boards (id, owner_id, name, key_hash) values
      ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000a2','Guest board', sha256(convert_to('guest-key','UTF8')));
    insert into sensors (id, owner_id, board_id, channel, label) values
      ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000b2',1,'G1');`);
});

const batch = (id: string, samples: object[]) => ({ client_batch_id: id, firmware_version: "0.1.0-dev", uptime_s: 100, wifi_rssi: -60, samples });
const sample = (channel: number, t: string, raw = 2000) => ({ channel, t, raw, spread: 20 });
const parse = (body: unknown) => {
  const r = parsePayload(body, NOW);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
};
const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);

// ---------- the SQL in the app must be the SQL in the repo ----------
test("INGEST_SQL matches db/queries/ingest_batch.sql", () => {
  const strip = (s: string) =>
    s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";")[0]!.replace(/\s+/g, " ").trim();
  const file = fs.readFileSync(path.join(dbDir, "queries/ingest_batch.sql"), "utf8");
  assert.equal(strip(INGEST_SQL), strip(file));
});

// ---------- validation ----------
const good = () => batch("11111111-1111-4111-8111-111111111111", [sample(1, "2026-11-03T21:45:00Z")]);

test("validation: accepts a good payload, fills spread default, normalizes time", () => {
  const v = parse({ ...good(), samples: [{ channel: 1, t: "2026-11-03T13:45:00-08:00", raw: 3000 }] });
  assert.equal(v.samples[0]!.t, "2026-11-03T21:45:00.000Z");
  assert.equal(v.samples[0]!.spread, 0);
});

const bad: [string, (b: any) => void][] = [
  ["non-object body", (b) => Object.keys(b).forEach((k) => delete b[k])],
  ["bad batch id", (b) => (b.client_batch_id = "nope")],
  ["empty samples", (b) => (b.samples = [])],
  ["raw out of range", (b) => (b.samples[0].raw = 5000)],
  ["raw not an integer", (b) => (b.samples[0].raw = 2000.5)],
  ["raw as string", (b) => (b.samples[0].raw = "2000")],
  ["channel 0", (b) => (b.samples[0].channel = 0)],
  ["time without zone", (b) => (b.samples[0].t = "2026-11-03T21:45:00")],
  ["time 1970 (no NTP)", (b) => (b.samples[0].t = "1970-01-01T00:00:10Z")],
  ["time in the future", (b) => (b.samples[0].t = "2026-11-03T23:00:00Z")],
  ["time 40 days old", (b) => (b.samples[0].t = "2026-09-20T00:00:00Z")],
  ["rssi positive", (b) => (b.wifi_rssi = 5)],
  ["too many samples", (b) => (b.samples = Array.from({ length: 501 }, () => sample(1, "2026-11-03T21:45:00Z")))],
];
for (const [name, mutate] of bad) {
  test(`validation: rejects ${name}`, () => {
    const b = good();
    mutate(b);
    assert.equal(parsePayload(name === "non-object body" ? null : b, NOW).ok, false);
  });
}

// ---------- auth ----------
test("auth: right key passes, wrong key / unknown board / garbage fail", async () => {
  assert.equal(await authenticateBoard(db, BOARD, "dev-only-secret"), true);
  assert.equal(await authenticateBoard(db, BOARD, "wrong"), false);
  assert.equal(await authenticateBoard(db, "00000000-0000-0000-0000-00000000ffff", "dev-only-secret"), false);
  assert.equal(await authenticateBoard(db, "not-a-uuid", "dev-only-secret"), false);
  assert.equal(await authenticateBoard(db, BOARD, ""), false);
  // the guest board's key must not open the dev board
  assert.equal(await authenticateBoard(db, BOARD, "guest-key"), false);
});

test("auth: hashKey is 32 bytes and stable", () => {
  assert.equal(hashKey("x").length, 32);
  assert.deepEqual(hashKey("x"), hashKey("x"));
});

// ---------- ingest ----------
const run = (id: string, samples: object[]) =>
  runInTransaction(db, () => ingestBatch(db, BOARD, parse(batch(id, samples))));

test("ingest: first post inserts, maps channel to sensor, touches the board", async () => {
  const before = await count("select count(*) n from readings");
  const r = await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", [sample(1, "2026-11-03T21:50:00Z", 2001), sample(2, "2026-11-03T21:50:00Z", 2002)]);
  assert.deepEqual(r, { received: 2, inserted: 2 });
  assert.equal(await count("select count(*) n from readings") - before, 2);
  const row = await db.query<{ raw: number }>(
    "select r.raw from readings r join sensors s on s.id=r.sensor_id where s.board_id=$1 and s.channel=2 and r.recorded_at='2026-11-03T21:50:00Z'", [BOARD]);
  assert.equal(row.rows[0]!.raw, 2002);
  const seen = await db.query<{ ok: boolean }>("select last_seen_at > now() - interval '1 minute' as ok from boards where id=$1", [BOARD]);
  assert.equal(seen.rows[0]!.ok, true);
});

test("ingest: exact retry inserts nothing and creates no second batch", async () => {
  const batches = await count("select count(*) n from batches");
  const r = await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", [sample(1, "2026-11-03T21:50:00Z", 2001), sample(2, "2026-11-03T21:50:00Z", 2002)]);
  assert.deepEqual(r, { received: 2, inserted: 0 });
  assert.equal(await count("select count(*) n from batches"), batches);
});

test("ingest: new batch with one overlapping sample inserts only the new one", async () => {
  const r = await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", [sample(1, "2026-11-03T21:50:00Z", 9), sample(1, "2026-11-03T21:55:00Z", 2003)]);
  assert.deepEqual(r, { received: 2, inserted: 1 });
  // the original value must be kept, not overwritten
  const row = await db.query<{ raw: number }>(
    "select r.raw from readings r join sensors s on s.id=r.sensor_id where s.board_id=$1 and s.channel=1 and r.recorded_at='2026-11-03T21:50:00Z'", [BOARD]);
  assert.equal(row.rows[0]!.raw, 2001);
});

test("ingest: same channel+time twice inside one payload is fine (first wins)", async () => {
  const r = await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", [sample(3, "2026-11-03T21:56:00Z", 2100), sample(3, "2026-11-03T21:56:00Z", 2200)]);
  assert.equal(r.inserted, 1);
});

test("ingest: a channel the board doesn't have is dropped, others are kept", async () => {
  const r = await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", [sample(1, "2026-11-03T21:57:00Z"), sample(9, "2026-11-03T21:57:00Z")]);
  assert.deepEqual(r, { received: 2, inserted: 1 });
});

test("ingest: boards can't write each other's sensors (same channel number, different board)", async () => {
  const before = await count("select count(*) n from readings where sensor_id='00000000-0000-0000-0000-0000000000e1'");
  await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", [sample(1, "2026-11-03T21:58:00Z")]);
  assert.equal(await count("select count(*) n from readings where sensor_id='00000000-0000-0000-0000-0000000000e1'"), before);
});

test("ingest: a database error rolls back everything, including the batch row", async () => {
  // bypass validation on purpose: this is the last line of defense (the CHECK constraint on raw)
  const p = parse(batch("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", [sample(1, "2026-11-03T21:59:00Z")]));
  p.samples[0]!.raw = 5000;
  await assert.rejects(runInTransaction(db, () => ingestBatch(db, BOARD, p)), /readings_raw_check/);
  assert.equal(await count("select count(*) n from batches where client_batch_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6'"), 0);
  // and the retry with good data must now go through (this is why it's one transaction)
  const r = await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", [sample(1, "2026-11-03T21:59:00Z")]);
  assert.equal(r.inserted, 1);
});
