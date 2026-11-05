-- ingest_batch.sql: how ONE POST from a board becomes rows. Run it inside a transaction.
-- Written for a Node driver (parameters $1..$10), not for pasting into psql.
--
--   $1  board id (already authenticated by the API: id + key hash matched)
--   $2  client_batch_id   (uuid the board generated for this POST)
--   $3  sample_count      (number of readings the board sent)
--   $4  wifi_rssi         (smallint or null)
--   $5  uptime_s          (integer or null)
--   $6  firmware_version  (text or null)
--   $7  channel           (smallint[])     \
--   $8  recorded_at       (timestamptz[])   | four arrays, same length, matched by position
--   $9  raw               (smallint[])      |
--   $10 spread            (smallint[])     /
--
-- The board sends CHANNEL NUMBERS (1..4), never sensor ids. The join on sensors turns
-- (this board, channel) into a sensor id. Adding a plant never changes the firmware.
--
-- Three safety properties, each one doing real work:
--   1. A retry is harmless. If (board_id, client_batch_id) already exists, the INSERT ... ON CONFLICT DO NOTHING
--      returns no row, so CTE "b" is empty, and the readings INSERT below it inserts nothing.
--   2. A board can only write readings for ITS OWN sensors. The join (se.board_id = $1) is what proves it.
--      A channel this board doesn't have simply matches nothing and is dropped.
--   3. Overlapping samples can't be inserted twice: ON CONFLICT on the primary key (sensor_id, recorded_at).
--      DO NOTHING also tolerates the same (channel, time) appearing twice inside ONE payload. DO UPDATE would
--      fail with "cannot affect row a second time".
--
-- In the app: BEGIN; run this; run the board update below; COMMIT. All in ONE transaction. If the batch row were
-- committed but the readings were lost to a crash, every retry would be ignored as "already received" and the data
-- would be gone for good.
--
-- The driver returns one row per reading actually inserted. If that count is lower than $3, it's a retry, an overlap,
-- or an unknown channel. Log it, don't fail it.

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

-- Same transaction, after the insert above:
-- update boards set last_seen_at = now(), firmware_version = coalesce($6, firmware_version) where id = $1;
