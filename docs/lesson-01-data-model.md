# Lesson 1: the data model (and how to do all of it by hand)

Everything here was run and checked before you got it (Postgres in a sandbox, same SQL). The goal: you could have written this yourself, and you can rebuild it with nothing but a terminal.

## 0. Run it yourself

```bash
cd ~/Desktop/Projects/aina-v2
docker compose -f db/docker-compose.yml up -d          # start Postgres 16 (needs Docker Desktop running)
docker compose -f db/docker-compose.yml ps             # wait for "healthy"

# apply the schema. -T = no terminal (needed when you pipe a file in). ON_ERROR_STOP = stop at the first error.
docker compose -f db/docker-compose.yml exec -T db psql -U aina -d aina -v ON_ERROR_STOP=1 < db/migrations/0001_init.sql
docker compose -f db/docker-compose.yml exec -T db psql -U aina -d aina -v ON_ERROR_STOP=1 < db/seed/dev_seed.sql

# open an interactive prompt
docker compose -f db/docker-compose.yml exec db psql -U aina -d aina
```

psql cheat sheet: `\dt` list tables, `\d readings` describe a table (columns, keys, constraints), `\dv` views, `\x` toggle vertical output, `\timing` show query time, `\q` quit.

Start over: `docker compose -f db/docker-compose.yml down -v` (the `-v` deletes the data), then `up -d` and re-apply.

## 1. The method: start from the questions, not the tables

Before drawing any table, list what the app must answer:

1. What is the latest reading of each sensor? (dashboard)
2. What did sensor X do over the last 7 days, as a percent? (chart)
3. Which sensors went quiet? (alerts, and this is the one people forget)
4. Did this POST from the board already arrive? (retries over bad wifi)
5. Whose data is this? (so "other people" later is an addition, not a rewrite)

Each table below exists because one of those questions needs it.

## 2. The tables, and why

| table | one row is | why it exists |
|---|---|---|
| `users` | a person | question 5 |
| `boards` | one ESP32 | holds the **hash** of its secret key (D-014) |
| `plants` | a plant | what you care about |
| `sensors` | one probe on one channel of one board | the link between hardware and plant; `unique (board_id, channel)` |
| `calibrations` | "dry = X, wet = Y" for a sensor from a moment on | each probe reads differently; insert-only so history stays interpretable |
| `batches` | one POST from a board | per-POST facts (wifi, uptime) stored once; carries the retry key |
| `readings` | one sensor at one time | the big table |

### Decisions worth understanding

**Store raw, compute percent later.** `readings.raw` is exactly what the ADC said. Percent is a view (`readings_calibrated`). If calibration is wrong you fix the calibration; the measurements are never damaged. Never store a derived number you can recompute.

**Composite primary key on readings: `(sensor_id, recorded_at)`.** One constraint does three jobs: identifies a row, makes a duplicate impossible, and is the index for "this sensor, this time range". No separate `id` column needed.

**Two layers of retry safety.** If the board sends a batch, wifi drops before the reply arrives, and the board resends:
- layer 1: `batches` has `unique (board_id, client_batch_id)`. The board makes the UUID, so the same POST has the same id.
- layer 2: the readings primary key rejects any overlapping sample.
Both are `ON CONFLICT DO NOTHING`, so a retry is a quiet no-op, not an error.

**Composite foreign keys for ownership.** `sensors` points at `boards (id, owner_id)` and `plants (id, owner_id)`. A foreign key must target something unique, which is why `boards` and `plants` have a redundant `unique (id, owner_id)`. Result: Postgres refuses to put user A's sensor in user B's plant, even if the app has a bug. Gotcha: with a NULL `plant_id`, the plant check is skipped (that's how "unassigned sensor" works).

**Insert-only calibrations + as-of join.** To get the percent of a reading, take the newest calibration whose `effective_at <= recorded_at`. That is `left join lateral (... order by effective_at desc limit 1)` in the view. Recalibrate on day 4 and the first four days keep their old meaning.

**Everything time-related is `timestamptz`.** It stores one absolute instant (UTC underneath). The display depends on the session time zone. `timestamp` (without tz) stores a wall clock with no meaning, and it is the classic source of "my chart is off by 7 hours".

**Check constraints are the last line of defense** (`raw between 0 and 4095`, `recorded_at >= 2024-01-01`). The recorded_at one exists because an ESP32 with no clock sync reports 1970. Don't use `now()` in a CHECK: checks must be deterministic, and a row valid today would be "invalid" when the table is re-checked.

## 3. Exercises: break it on purpose

Run each in psql. The expected result is in the comment. Reading the error is the skill.

```sql
-- A. impossible value
insert into readings (sensor_id, recorded_at, raw, batch_id)
select sensor_id, now(), 5000, batch_id from readings limit 1;
-- ERROR 23514: violates check constraint "readings_raw_check"

-- B. a board with no clock (1970)
insert into readings (sensor_id, recorded_at, raw, batch_id)
select sensor_id, timestamptz '1970-01-01 00:00+00', 2000, batch_id from readings limit 1;
-- ERROR 23514: violates a check constraint on recorded_at

-- C. duplicate reading, two ways
insert into readings select * from readings order by recorded_at limit 1;
-- ERROR 23505: duplicate key violates unique constraint "readings_pkey"
insert into readings select * from readings order by recorded_at limit 1 on conflict do nothing;
-- INSERT 0 0   (silently skipped; this is what a retry looks like)

-- D. link a sensor to ANOTHER user's plant (guest plant ...c9)
update sensors set plant_id = '00000000-0000-0000-0000-0000000000c9' where label = 'S1';
-- ERROR 23503: violates foreign key constraint (the owner pair doesn't match)

-- E. two sensors on the same channel
insert into sensors (owner_id, board_id, channel)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 1);
-- ERROR 23505: unique (board_id, channel)

-- F. calibration with dry = wet (would divide by zero)
insert into calibrations (sensor_id, dry_raw, wet_raw)
values ('00000000-0000-0000-0000-0000000000d1', 2000, 2000);
-- ERROR 23514
```

Error codes: 23502 not null, 23503 foreign key, 23505 unique, 23514 check. You'll see these in app logs, so the codes are worth learning.

## 4. The queries the app will run

```sql
-- Q1 latest per sensor (DISTINCT ON keeps the first row per sensor_id after sorting)
select s.label, l.recorded_at, l.raw from sensor_latest l join sensors s on s.id = l.sensor_id order by s.label;

-- Q3 quiet sensors, written the RIGHT way
select s.label, l.recorded_at
from sensors s left join sensor_latest l on l.sensor_id = s.id
where l.recorded_at is null or l.recorded_at < now() - interval '7 hours';
-- expect S3 (silent for the last 12 hours of the seed)
```

**The trap:** the "obvious" version is `select sensor_id, max(recorded_at) from readings group by sensor_id having max(recorded_at) < now() - interval '7 hours'`. It finds S3 but can never find a sensor with **zero** readings, because that sensor has no rows to group. A brand-new or dead-from-day-one sensor is exactly the one you want an alert for. Start from `sensors`, `LEFT JOIN` to readings, and test for NULL.

```sql
-- Q2 as-of join proof: sensor S2 was recalibrated at day 4
select dry_raw, wet_raw, count(*) from readings_calibrated
where sensor_id = '00000000-0000-0000-0000-0000000000d2' group by 1, 2 order by 1;
-- 2600/1300 -> 288 rows (after recal)    2700/1250 -> 384 rows (before)
-- 7 days x 96 samples = 672 = 384 + 288 (4 days before, 3 days after)
```

## 5. The ingest query, and why one transaction

`db/queries/ingest_batch.sql` turns one POST into rows. Read its header comments; each safety property is tested:

| case | result |
|---|---|
| first post, 2 samples | 2 rows inserted |
| exact retry (same client_batch_id) | 0 rows, nothing changed |
| new batch, 1 overlapping sample | only the new sample inserted |
| board posts a channel it doesn't have | that sample **silently dropped**, the rest kept |
| two boards both have a "channel 1" | each board's sample lands on its own sensor only |
| empty arrays | 0 readings, but a batch row IS recorded (harmless, shows the board was alive) |
| arrays of different length | error 23502 (unnest pads the short one with NULL): loud, good |
| `raw = 5000` in the middle of a batch | whole statement fails, nothing inserted |
| same, inside BEGIN...ROLLBACK | batch row also gone |

**Why ONE transaction:** the batch row and its readings must succeed or fail together. If the batch row committed and then the server crashed before the readings, every retry would hit `unique (board_id, client_batch_id)`, be ignored as "already received", and that data would be lost for good. Postgres makes this easy: `BEGIN; ...; COMMIT;`, and any error means `ROLLBACK`.

The board sends **channel numbers** (1 to 4), not sensor ids. The query joins `sensors` on `(this board, channel)` to find the sensor. That way firmware never has to know a database id, and adding a plant changes nothing on the device. (Lesson 2 builds the API around this query.)

Gotcha: "dropped silently" for an unknown channel is a choice. The API reports `received` and `inserted` back so a difference is visible.

## 6. Node driver gotchas (you'll hit these in the API step)

```sql
select pg_typeof(count(*)), pg_typeof(sum(raw)), pg_typeof(avg(raw)), pg_typeof(max(raw)) from readings;
-- bigint, bigint, numeric, smallint
```
Node drivers hand back `bigint` and `numeric` as **strings** (they don't fit a JS number safely), and `timestamptz` as a `Date`. So `count(*)` gives `"2640"`, and `"2640" + 1` is `"26401"`. Cast in SQL (`count(*)::int`) or convert in code.

Also: always use parameters (`$1`), never string-concatenate SQL; don't open a new connection pool per serverless invocation.

## 7. Sizing: is this going to be a problem?

384 readings/day (4 sensors x 96) is about 140,000 rows/year. Tiny. Postgres will not notice for years, so no partitioning, no downsampling job, no timeseries extension. Revisit if you add sensors by 100x. The free-tier limit that matters is the **storage cap** (Neon's free database size), and this is roughly tens of MB per year.

## 8. Known gaps (deliberate, noted so you can fix them later)

- No index on `batches.board_id` / `readings.batch_id`. Postgres does **not** index foreign key columns automatically. Fine at this size; add if deleting a board gets slow.
- "Calibrations are insert-only" is a convention, not enforced. A trigger or revoking UPDATE could enforce it.
- `sensors.plant_id` reassignment loses history (which plant was it in last month?). A `sensor_assignments` table would fix it; add when the UI needs it.
- No users/auth columns yet (open decision).

## 9. Adding to the schema later

Never edit `0001_init.sql` after it's been applied somewhere. Add `0002_*.sql`: `alter table ... add column ...`, wrapped in `begin; ... commit;`. Adding a nullable column is instant and safe. Name the file for what it does and keep them in order. We'll pick a migration runner later; until then you apply them with the same `psql -f` command.
