-- dev_seed.sql: FAKE data for learning and tests. Not measurements. Never run this on a real database.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed/dev_seed.sql
--
-- What it builds (all times are relative to "now", so it never goes stale):
--   * 2 users, 1 board, 4 sensors in 4 pots, plus a guest user with a plant (for the cross-owner exercise)
--   * 7 days of samples every 15 minutes, posted in batches every 3 hours (D-011, D-013)
--   * sensor S3 goes silent after 6.5 days (so the "quiet sensor" query has something to find)
--   * sensor S4 is noisy (like channel 4 on the bench)
--   * sensor S2 gets a second calibration at day 4 (so the as-of join has something to show)

begin;

select setseed(0.42);   -- makes random() repeatable within this session

-- Anchor: the top of the current hour, 7 days ago. Every sample is start + n * 15 minutes.
create temp table seed_anchor as
select date_trunc('hour', now()) - interval '7 days' as start_at;

insert into users (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Dev User'),
  ('00000000-0000-0000-0000-0000000000a2', 'Guest User');

insert into boards (id, owner_id, name, key_hash, firmware_version) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
   'Windowsill board', sha256(convert_to('dev-only-secret', 'UTF8')), '0.1.0-dev');

insert into plants (id, owner_id, name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Pot 1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Pot 2'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'Pot 3'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'Pot 4'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a2', 'Guest plant');

insert into sensors (id, owner_id, board_id, channel, label, plant_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 1, 'S1', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 2, 'S2', '00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 3, 'S3', '00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 4, 'S4', '00000000-0000-0000-0000-0000000000c4');

-- Calibrations. effective_at is set 8 days back so they cover the whole 7 days of readings.
-- (Fake numbers: dry 2700 / wet 1250 is roughly what the first bench sensor showed in air and in water.)
insert into calibrations (sensor_id, dry_raw, wet_raw, effective_at, note)
select s.id, 2700, 1250, (select start_at from seed_anchor) - interval '1 day', 'fake initial calibration'
from sensors s;

-- S2 is recalibrated at day 4 (insert a NEW row; never edit the old one).
insert into calibrations (sensor_id, dry_raw, wet_raw, effective_at, note)
values ('00000000-0000-0000-0000-0000000000d2', 2600, 1300,
        (select start_at from seed_anchor) + interval '4 days', 'fake recalibration at day 4');

-- 56 batches (8 per day x 7 days). Batch k holds samples n = 12k .. 12k+11 and arrives right after the last one.
create temp table batch_map (k integer primary key, batch_id uuid not null default gen_random_uuid());
insert into batch_map (k) select generate_series(0, 55);

insert into batches (id, board_id, client_batch_id, received_at, sample_count, wifi_rssi, uptime_s, firmware_version)
select m.batch_id,
       '00000000-0000-0000-0000-0000000000b1',
       gen_random_uuid(),
       (select start_at from seed_anchor) + (m.k + 1) * interval '3 hours',
       0,                                     -- filled in after the readings exist
       -55 - (random() * 15)::int,
       (m.k + 1) * 10800,                     -- uptime grows by 3 hours per batch: no reboots in this fake week
       '0.1.0-dev'
from batch_map m;

-- Readings: 672 samples per sensor (7 days x 96). A simple sawtooth: wet right after watering,
-- drying for ~4 days, watered again. Each sensor has a different watering phase.
insert into readings (sensor_id, recorded_at, raw, spread, batch_id)
select s.id,
       a.start_at + n * interval '15 minutes',
       least(4095, greatest(0, round(
         2700 - (2700 - 1250) * (0.9 - 0.7 * ((n + s.phase) % 384) / 384.0)   -- 0.9 wet -> 0.2 dry
         + (random() - 0.5) * 30)))::smallint,
       (case when s.label = 'S4' then 250 + random() * 250 else 10 + random() * 50 end)::smallint,
       m.batch_id
from (
  select id, label,
         case label when 'S1' then 0 when 'S2' then 96 when 'S3' then 192 else 288 end as phase
  from sensors
) s
cross join seed_anchor a
cross join generate_series(0, 671) as n
join batch_map m on m.k = n / 12
where not (s.label = 'S3' and n >= 624);      -- S3 falls silent after 6.5 days

update batches b
set sample_count = c.n
from (select batch_id, count(*) as n from readings group by batch_id) c
where c.batch_id = b.id;

update boards set last_seen_at = (select max(received_at) from batches);

commit;
