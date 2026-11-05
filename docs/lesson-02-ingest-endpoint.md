# Lesson 2: the ingest endpoint (and how to build it by hand)

Goal: a board can POST a batch of readings and they land in Postgres, safely, even if the post is repeated. The contract firmware must follow is `docs/api.md`.

Everything below was run for real: 24 automated tests, a `next build`, and `curl` against a live server talking to a real Postgres 16.

## 0. The shape of it

```
ESP32 --HTTPS POST--> Next.js route handler --> Postgres
        (id + key)     1. size check
                       2. who is this? (hash the key, compare)
                       3. validate the JSON
                       4. ONE transaction: batch row + readings + last_seen
```

Order matters. Each step is cheap and rejects bad input before the more expensive step runs.

## 1. Run it on your laptop

```bash
cd ~/Desktop/Projects/aina-v2

# database (Docker Desktop must be running)
docker compose -f db/docker-compose.yml up -d
docker compose -f db/docker-compose.yml exec -T db psql -U aina -d aina -v ON_ERROR_STOP=1 < db/migrations/0001_init.sql
# skip the seed here: it is fake data for lesson 1. Bootstrap makes the REAL user, board and sensors.

cd web
cp .env.local.example .env.local          # defaults already point at the Docker database
npm install
npm test                                   # 24 tests, uses an in-memory Postgres, needs no Docker
npm run bootstrap -- --user "Munir" --board "Windowsill board"
#   prints USER_ID, BOARD_ID, BOARD_KEY. Copy them now. The key is shown once; the DB keeps only its hash.
npm run dev                                # http://localhost:3000
```

In a second terminal:

```bash
curl -s localhost:3000/api/health                          # {"ok":true,"db_ms":..}

export BASE_URL=http://localhost:3000 BOARD_ID=<from bootstrap> BOARD_KEY=<from bootstrap>
./scripts/post-sample.sh                 # 200 {"ok":true,"received":4,"inserted":4}
./scripts/post-sample.sh same-batch      # 200 ... "inserted":0   <- a retry. nothing stored twice
BOARD_KEY=nope ./scripts/post-sample.sh  # 401

docker compose -f ../db/docker-compose.yml exec db psql -U aina -d aina -c \
  "select s.label, r.recorded_at, r.raw, r.spread from readings r join sensors s on s.id=r.sensor_id order by 2,1 desc limit 8"
```

(You might need `chmod +x scripts/post-sample.sh`. Or run it with `bash scripts/post-sample.sh`.)

## 2. The files, and the reason for each

| file | job | the idea to take away |
|---|---|---|
| `src/lib/db.ts` | one `pg` Pool | Stored on `globalThis` so dev-mode hot reloads don't leak pools. `max: 3` because every serverless instance has its own pool |
| `src/lib/tx.ts` | `runInTransaction` | BEGIN/COMMIT/ROLLBACK on **one** connection. Using the pool object itself would split the transaction across connections |
| `src/lib/auth.ts` | `authenticateBoard` | Hash what the board sent, compare with `timingSafeEqual`. Same 401 for unknown board and wrong key |
| `src/lib/validate.ts` | `parsePayload` | The device is untrusted input. Every field has a type and a range. Returns `{ok, error}` instead of throwing |
| `src/lib/ingest.ts` | the SQL + a thin function | Turns the payload into 4 parallel arrays and runs `db/queries/ingest_batch.sql` |
| `src/app/api/ingest/route.ts` | the HTTP part | Status codes, size limit, always `client.release()` |
| `scripts/bootstrap.mjs` | first user/board/sensors, key rotation | Generates the key from 32 random bytes, stores only the hash |
| `test/ingest.test.ts` | 24 tests | Includes one that fails if the SQL in the app drifts from the SQL in `db/` |

### The decisions inside, with reasons

**`pg` as the driver (decision D-012 left the driver open, so this is a proposal).** It talks to Docker Postgres and Neon with the same code. Neon's own serverless driver would be a little better on Vercel's cold starts but doesn't speak to a local Docker Postgres without extra setup. We can swap later; only `db.ts` and the `tx` helper would change.

**Channel numbers, not sensor ids, in the payload.** The firmware only knows "channel 2". The database knows which sensor that is for this board. Rewire a plant, and nothing on the device changes.

**Same 401 for unknown board and wrong key.** If they differed, anyone could test which board ids exist. `authenticateBoard` also compares against a dummy hash when the board is missing, so the timing doesn't leak it either.

**Validation rejects, it doesn't repair.** A timestamp of 1970 means the board's clock isn't set. Silently accepting it would put garbage in your history; rejecting makes the firmware bug visible on day one.

**`last_seen_at` updates even on a retry.** A retry proves the board is alive, and that's what the "quiet sensor" alert needs.

## 3. Gotchas (all of these are real; most are covered by a test)

- **Timestamps without a zone** (`2026-11-03T21:45:00`): JavaScript reads that as the *server's* local time. Same payload, different instant on your Pacific laptop vs Vercel's UTC. The API requires `Z` or an offset. (`date -u +%Y-%m-%dT%H:%M:%SZ` in the shell script is that, on purpose.)
- **Never run `begin` on the pool.** `pool.query("begin")` then `pool.query("insert...")` can go to two different connections. Always `pool.connect()` to get one client, and `release()` in `finally`. Forget the release and the pool is empty after three errors; the 4th request hangs.
- **`ON CONFLICT DO NOTHING` vs `DO UPDATE`.** `DO NOTHING` tolerates the same row twice in one statement. `DO UPDATE` would throw "cannot affect row a second time". We want first-write-wins for readings, so `DO NOTHING`.
- **`content-length` can be missing or false.** Check the header for an early rejection, *and* check the real text length.
- **The route must be `runtime = "nodejs"`.** `pg` needs Node's `net` and `crypto`; the edge runtime doesn't have them.
- **`.env.local` is read by `next dev`, but plain `node` doesn't read it.** That's why bootstrap runs as `node --env-file=.env.local`.
- **A key in an HTTP request is readable by anyone on the same wi-fi.** Local testing over `http://` is fine for a dev key. The real deployment must be HTTPS only, and the firmware must verify the certificate (D-009).
- **Rate limiting is not implemented.** An attacker with a valid key could post a lot, and an attacker without one can make us do one tiny indexed lookup per request. Fine for a hobby deployment; revisit before opening to other people.
- **Plain SHA-256 for the key hash** is OK only because the key is 256 random bits. Never do that for human passwords.

## 4. Exercises

1. **Predict, then check.** Before running, write down the status code for each: (a) no `Authorization` header, (b) a `t` of `2026-11-03T21:45:00`, (c) `raw: 4096`, (d) channel 7, (e) the same batch twice. Then try each with `curl`. Answers: 401, 400, 400, 200 with `inserted: 0`, 200 with `inserted: 0` the second time.
2. **Crash safety.** In `route.ts`, temporarily throw an error after `ingestBatch` but before it returns. Post a batch. Is anything in `batches`? (No: the whole transaction rolls back.) Now move the throw so the batch insert is in a *separate* transaction from the readings and see what a retry does. That's the bug the single transaction prevents.
3. **Rotate the key.** `npm run bootstrap -- --rotate <BOARD_ID>`, then post with the old key. Expect 401.
4. **Break a test on purpose.** Change `MAX_SAMPLES` to 400 and run `npm test`. Which test fails, and why is a test for that limit worth having?
5. **Size it.** One post with 4 channels x 12 samples is about 3 KB of JSON. A post every 3 hours is 8 per day. How many Vercel function invocations per month? (About 240. Nowhere near any free limit.)

## 5. Putting it on the internet (Neon + Vercel)

Do this once the local version works. The vendor dashboards change, so go by the names, not exact button positions.

**Neon (database)**
1. Sign up at neon.com, create a project. Pick a region close to where your Vercel functions will run (US East is the default for both).
2. In the dashboard, copy the **pooled** connection string (the host contains `-pooler`; it ends with `?sslmode=require`).
3. Put it in a **separate** file so you never confuse it with local: `web/.env.neon.local` containing `DATABASE_URL=...`. The name matters: `.gitignore` ignores `.env*.local`, so this file can never be committed by accident.
4. Apply the migration (no seed!). If you have no local `psql`, use the one inside Docker:
   ```bash
   docker run --rm -i postgres:16-alpine psql "<paste the connection string>" -v ON_ERROR_STOP=1 < db/migrations/0001_init.sql
   ```
5. Create the real board on Neon:
   ```bash
   cd web
   node --env-file=.env.neon.local scripts/bootstrap.mjs --user "Munir" --board "Windowsill board"
   ```
   Save the new BOARD_ID and BOARD_KEY in a password manager. These are the ones the firmware will use.

**Vercel (the app)**
1. Install the CLI (`npm i -g vercel`) or connect a GitHub repo in the dashboard.
2. The Next.js app is in `web/`, not the repo root. In the project settings set **Root Directory** to `web`. (Forgetting this is the most common first-deploy failure: "no Next.js found".)
3. Add the environment variable `DATABASE_URL` (the pooled Neon string) for Production.
4. Deploy. Then:
   ```bash
   curl -s https://<your-app>.vercel.app/api/health            # first call may be slow: Neon waking up
   BASE_URL=https://<your-app>.vercel.app BOARD_ID=... BOARD_KEY=... ./scripts/post-sample.sh
   ```
5. Run the health check twice, a few minutes apart, and note `db_ms`. That is the Neon cold-start number our requirements doc still lists as unmeasured.

Check: if you see Vercel's "deployment protection" login page instead of JSON, the project is protected. The board can't log in, so the API route must be reachable without it. (Check the project's protection settings; the exact option names vary by plan.)

## 6. What's deliberately not built yet

- No dashboard; the home page is a placeholder.
- No alerts or "quiet sensor" job (the query is in lesson 1; the delivery method is an open decision).
- No migrations runner; migrations are applied with `psql`.
- No rate limiting, no key-per-request signing. HTTPS plus a long random key is the v1 security model (D-014).
- Calibration is not applied on ingest. Raw is stored; percent is a view.

Next lesson: the firmware side. Connect to wi-fi, set the clock with NTP, sample on a schedule, build the JSON above, and POST it with certificate checking.
