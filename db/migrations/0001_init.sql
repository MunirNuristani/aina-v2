-- 0001_init.sql
-- AINA v2: first schema. Run it with psql, never by pasting into a GUI one statement at a time:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
-- ON_ERROR_STOP matters: by default psql PRINTS an error and keeps going, so the real error gets buried
-- under a pile of follow-on errors (and in a file WITHOUT begin/commit it would leave half the changes applied).
--
-- The whole file runs in ONE transaction. Postgres DDL (create table, etc.) is transactional,
-- so if anything fails, nothing is created and you can just fix the file and run it again.

begin;

-- ---------------------------------------------------------------------------
-- users: who owns things. v1 is one household, but every board and plant has an owner
-- from day one so "other people" later is an addition, not a rewrite (tension T1).
-- No email/password yet: the auth decision isn't made, and a later migration can add columns.
-- ---------------------------------------------------------------------------
create table users (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- boards: one ESP32. It proves who it is with a secret key (D-014).
-- We store only the SHA-256 hash of the key, never the key itself.
-- ---------------------------------------------------------------------------
create table boards (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references users (id),
  name              text not null check (length(btrim(name)) > 0),
  key_hash          bytea not null check (octet_length(key_hash) = 32),
  key_created_at    timestamptz not null default now(),
  firmware_version  text,
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),
  -- Redundant with the primary key on purpose: a foreign key can only point at something
  -- UNIQUE, and sensors will point at the PAIR (id, owner_id). See sensors below.
  unique (id, owner_id)
);

-- ---------------------------------------------------------------------------
-- plants: the thing you care about. Sensors are assigned to plants.
-- ---------------------------------------------------------------------------
create table plants (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users (id),
  name        text not null check (length(btrim(name)) > 0),
  species     text,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (id, owner_id)
);

-- ---------------------------------------------------------------------------
-- sensors: one physical probe, wired to one channel of one board.
-- plant_id is NULL while a sensor isn't installed in a plant.
-- Several sensors may share a plant (a big pot); we can add a unique constraint later if not.
--
-- The two composite foreign keys are the multi-user safety net: a sensor can only sit on a
-- board AND in a plant that belong to the same owner. Postgres checks it for us, so a bug in
-- the app can't link two different people's data. (If plant_id is NULL the plant check is skipped.)
-- ---------------------------------------------------------------------------
create table sensors (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null,
  board_id    uuid not null,
  channel     smallint not null check (channel >= 1),
  label       text,                      -- the tape label, e.g. 'S1'
  model       text,
  plant_id    uuid,
  created_at  timestamptz not null default now(),
  unique (board_id, channel),
  foreign key (board_id, owner_id) references boards (id, owner_id),
  foreign key (plant_id, owner_id) references plants (id, owner_id)
);

-- ---------------------------------------------------------------------------
-- calibrations: raw counts that mean "bone dry" and "fully wet" for ONE sensor.
-- Insert-only by convention: recalibrating adds a row, it never edits one, so old readings can
-- still be interpreted with the calibration that was in effect when they were taken.
-- ---------------------------------------------------------------------------
create table calibrations (
  id            uuid primary key default gen_random_uuid(),
  sensor_id     uuid not null references sensors (id),
  dry_raw       smallint not null check (dry_raw between 0 and 4095),
  wet_raw       smallint not null check (wet_raw between 0 and 4095),
  effective_at  timestamptz not null default now(),
  note          text,
  check (dry_raw <> wet_raw),            -- equal values would divide by zero
  unique (sensor_id, effective_at)
);

-- ---------------------------------------------------------------------------
-- batches: one row per POST from a board. Per-post facts live here once, not on every reading.
-- client_batch_id is made by the BOARD (a random UUID). If the board resends the same batch
-- because it never saw our reply, the unique constraint tells us we already have it.
-- ---------------------------------------------------------------------------
create table batches (
  id               uuid primary key default gen_random_uuid(),
  board_id         uuid not null references boards (id),
  client_batch_id  uuid not null,
  received_at      timestamptz not null default now(),
  sample_count     integer not null check (sample_count >= 0),
  wifi_rssi        smallint,
  uptime_s         integer check (uptime_s >= 0),   -- a drop between batches means the board rebooted
  firmware_version text,
  unique (board_id, client_batch_id)
);

-- ---------------------------------------------------------------------------
-- readings: the big table. One row per sensor per sample time.
-- raw    = median of the oversampled ADC counts (0..4095). Stored exactly as measured, never changed.
-- spread = max minus min of those samples. Big spread = noisy or disconnected (T7).
-- The primary key (sensor_id, recorded_at) does three jobs at once:
--   1. identifies a reading, 2. makes a retried reading impossible to insert twice,
--   3. is the index that makes "this sensor, last 7 days" fast.
-- ---------------------------------------------------------------------------
create table readings (
  sensor_id    uuid not null references sensors (id),
  recorded_at  timestamptz not null check (recorded_at >= timestamptz '2024-01-01 00:00+00'),
  raw          smallint not null check (raw between 0 and 4095),
  spread       smallint not null default 0 check (spread between 0 and 4095),
  batch_id     uuid not null references batches (id),
  primary key (sensor_id, recorded_at)
);

-- ---------------------------------------------------------------------------
-- Views: saved queries. They store no data; they just give a name to a query you'd write often.
-- ---------------------------------------------------------------------------

-- Every reading with its moisture percent, using the calibration that was in effect
-- AT THE TIME of the reading (an "as-of join": the newest calibration not newer than the reading).
-- No calibration yet means moisture_pct is NULL. We never invent a number.
create view readings_calibrated as
select r.sensor_id,
       r.recorded_at,
       r.raw,
       r.spread,
       c.dry_raw,
       c.wet_raw,
       case when c.id is null then null
            else round(greatest(0, least(100,
                   100.0 * (c.dry_raw - r.raw) / (c.dry_raw - c.wet_raw)))::numeric, 1)
       end as moisture_pct
from readings r
left join lateral (
  select c.id, c.dry_raw, c.wet_raw
  from calibrations c
  where c.sensor_id = r.sensor_id
    and c.effective_at <= r.recorded_at
  order by c.effective_at desc
  limit 1
) c on true;

-- The newest reading of each sensor.
create view sensor_latest as
select distinct on (sensor_id) sensor_id, recorded_at, raw, spread
from readings
order by sensor_id, recorded_at desc;

commit;
