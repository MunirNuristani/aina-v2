import type { Queryable } from "./tx";
import type { Payload } from "./validate";

// KEEP IN SYNC with db/queries/ingest_batch.sql (that file has the long explanation). test/ingest.test.ts
// fails if the two drift apart. It is a string here, not read from disk, because on Vercel the function bundle
// does not include files outside the web/ folder.
export const INGEST_SQL = `
with b as (
  insert into batches (board_id, client_batch_id, sample_count, wifi_rssi, uptime_s, firmware_version)
  values ($1, $2, $3, $4, $5, $6)
  on conflict (board_id, client_batch_id) do nothing
  returning id
)
insert into readings (sensor_id, recorded_at, raw, spread, batch_id)
select se.id, x.recorded_at, x.raw, x.spread, b.id
from b
cross join unnest($7::smallint[], $8::timestamptz[], $9::smallint[], $10::smallint[])
     as x(channel, recorded_at, raw, spread)
join sensors se on se.board_id = $1 and se.channel = x.channel
on conflict (sensor_id, recorded_at) do nothing
returning sensor_id;
`;

export const TOUCH_BOARD_SQL = `
update boards set last_seen_at = now(), firmware_version = coalesce($2, firmware_version) where id = $1
`;

export type IngestResult = { received: number; inserted: number };

// Call inside runInTransaction, with an already-authenticated board id.
export async function ingestBatch(q: Queryable, boardId: string, p: Payload): Promise<IngestResult> {
  const { rows } = await q.query(INGEST_SQL, [
    boardId,
    p.clientBatchId,
    p.samples.length,
    p.wifiRssi,
    p.uptimeS,
    p.firmwareVersion,
    p.samples.map((s) => s.channel),
    p.samples.map((s) => s.t),
    p.samples.map((s) => s.raw),
    p.samples.map((s) => s.spread),
  ]);
  // Even a pure retry counts as "the board is alive".
  await q.query(TOUCH_BOARD_SQL, [boardId, p.firmwareVersion]);
  return { received: p.samples.length, inserted: rows.length };
}
