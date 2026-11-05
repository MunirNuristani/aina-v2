import { createHash, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./tx";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SHA-256 of the key, as 32 raw bytes (the type of boards.key_hash).
// Plain SHA-256 is fine HERE because the key is 256 random bits, so there is nothing to brute-force.
// For human passwords you would need a slow hash (argon2/bcrypt). Don't copy this pattern for those.
export function hashKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

// A hash that matches no real key. Compared against when the board doesn't exist, so "no such board"
// and "wrong key" take the same amount of work.
const DUMMY_HASH = hashKey("no-such-board");

export async function authenticateBoard(q: Queryable, boardId: string, key: string): Promise<boolean> {
  // A malformed uuid would make Postgres throw (22P02) and turn a bad request into a 500.
  if (!UUID_RE.test(boardId) || key.length === 0 || key.length > 200) return false;

  const { rows } = await q.query("select key_hash from boards where id = $1", [boardId]);
  const stored = rows[0]?.key_hash;
  // pg gives a Buffer, PGlite a Uint8Array. Buffer.from handles both.
  const expected = stored ? Buffer.from(stored) : DUMMY_HASH;
  const given = hashKey(key);

  // timingSafeEqual throws if the lengths differ, so check first (both are 32 here).
  const equal = expected.length === given.length && timingSafeEqual(expected, given);
  return Boolean(stored) && equal;
}
