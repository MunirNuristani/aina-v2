# Lesson 3: CI/CD with GitHub Actions and Vercel

**CI** (continuous integration) = every change is automatically built and tested on a clean machine, so "works on my laptop" stops being a defense.
**CD** (continuous delivery/deployment) = a change that passed gets shipped without you running deploy commands.

Our setup:

```
branch + pull request ──► GitHub Actions: typecheck, tests, build, migrations on real Postgres
                    │             │ (must be green before merge)
                    └──► Vercel: builds a PREVIEW url for the PR
merge to main ──────────► Vercel: builds and deploys PRODUCTION
```

CI is one file: `.github/workflows/ci.yml`. CD is not a file at all: it's Vercel watching the GitHub repo.

## 1. Put the project in git and on GitHub

The `aina-v2` folder is not a git repo yet. On your Mac:

```bash
cd ~/Desktop/Projects/aina-v2

# The workflow file has to live at .github/workflows/ci.yml for GitHub to find it. My tools aren't allowed to write
# into .github/, so it was left at docs/ci.yml. Move it into place:
mkdir -p .github/workflows && mv docs/ci.yml .github/workflows/ci.yml

git init -b main
git add .
git status            # READ THIS before committing
```

What `git status` must **not** list: `node_modules/`, `.next/`, `.env.local`, `.pio/`, `.DS_Store`, anything called `secrets`. They're in `.gitignore`. If one shows up, stop and fix `.gitignore` first. Removing a committed secret later is much harder than not committing it (it stays in history; you'd have to rotate the key).

```bash
git commit -m "Initial import: db, ingest endpoint, bench tests, docs"
```

Create the GitHub repo. Either:

- web: github.com → New repository → name `aina-v2` → **do not** tick "add README/.gitignore/license" (it must be empty, or the first push conflicts), then:
  ```bash
  git remote add origin https://github.com/MunirNuristani/aina-v2.git
  git push -u origin main
  ```
- or with the GitHub CLI, if you have it (`brew install gh`, `gh auth login`):
  ```bash
  gh repo create aina-v2 --private --source . --push
  ```

**Private or public?** Nothing secret is in the repo (the dev passwords in `docker-compose.yml` and the seed are dev-only on purpose). Public repos get free Actions minutes; private repos have a monthly free allowance, and this CI uses a couple of minutes per run, so either is fine. One difference that matters: as far as I know, **branch protection (section 4) is not available on private repos on the free plan**. GitHub shows an upgrade prompt if so. If you want the enforcement, make the repo public.

## 2. Watch CI run

Open the repo → **Actions** tab. The push to `main` triggered "CI". Click it. You'll see two jobs running in parallel.

How to read the workflow file, top to bottom:

| piece | meaning |
|---|---|
| `on: push (main), pull_request` | when to run |
| `permissions: contents: read` | the job's token can only read the code. Least privilege: a compromised dependency can't push to your repo |
| `concurrency ... cancel-in-progress` | a newer push to the same branch cancels the older run |
| `runs-on: ubuntu-latest` | a fresh, empty Linux VM for every run |
| `uses: actions/checkout@v4` | copies your repo onto that VM (it starts empty) |
| `setup-node` with `cache: npm` | installs Node 22 and caches npm's download folder between runs |
| `npm ci` | install exactly what `package-lock.json` says; fail if package.json and the lock disagree |
| `defaults.run.working-directory: web` | every `run:` step starts in `web/`, because the app isn't at the repo root |
| `services: postgres` | starts a real Postgres 16 container next to the job, with a health check so the steps wait until it's ready |
| `-v ON_ERROR_STOP=1` | psql exits non-zero on the first SQL error. Without it, the job would pass while broken |

Why two jobs: the `web` job tests the TypeScript app with an in-memory Postgres. The `db` job runs your actual `.sql` files on real Postgres 16, in filename order, on an empty database. When you add `0002_*.sql`, it's applied automatically after `0001`.

## 3. Make it fail on purpose (exercise)

A check you've never seen fail is a check you can't trust.

```bash
git switch -c break-ci
```

**a. Break the types.** In `web/src/lib/auth.ts` change `return Boolean(stored) && equal;` to `return "yes";` then:
```bash
git commit -am "test: break typecheck" && git push -u origin break-ci
```
Open a pull request (GitHub shows a banner "Compare & pull request"). The `web` check goes red; click Details and find the `tsc` error. Fix it, commit, push, and watch the same PR turn green.

**b. Break a migration.** Add a typo to `db/migrations/0001_init.sql` (for example `crate table`). The `db` job fails and prints the SQL error, but the `web` job stays green: that's why they're separate jobs. (Real life: never edit an applied migration; this is only an exercise. Revert it.)

**c. Break a test.** In `web/src/lib/validate.ts` change `MAX_SAMPLES` to 400. The `web` job fails on the specific test.

Close the PR without merging when you're done.

## 4. Make green mean something: branch protection

CI that nobody has to obey is decoration. In the repo: **Settings → Branches** (or **Rules → Rulesets**) → add a rule for `main`:

- Require a pull request before merging
- Require status checks to pass: select **web (typecheck, test, build)** and **db (migrations and seed on real Postgres 16)**
- Optional: require branches to be up to date before merging

Gotcha: the check names only appear in the dropdown **after they have run at least once**, which is why we push first.

From now on you work in branches and merge pull requests; `main` only ever contains code that passed. Solo, this feels like ceremony, and it is, until the one time it catches a broken deploy. It's also the workflow every team uses, so it's worth practicing.

## 5. CD: connect Vercel to the repo

In Vercel (you're already signed in): **Add New → Project → Import Git Repository**.

1. Authorize the Vercel GitHub app. Choose "only select repositories" and pick `aina-v2` (least privilege again).
2. **Root Directory: `web`.** Forgetting this is the classic first-deploy failure ("no Next.js found").
3. Framework preset: Next.js (detected automatically).
4. Environment variables: `DATABASE_URL` = the pooled Neon string (lesson 2, section 5). **Set it for Production only** (see the gotcha below).
5. Deploy.

What you get for free after that:
- Push/merge to `main` → production deploy.
- Every pull request → a preview deployment with its own URL, linked in the PR.

### Gotchas

- **Previews must not touch the production database.** If `DATABASE_URL` is enabled for "Preview", every PR's preview can write into the real data (and a bad test post would). Uncheck Preview and Development for that variable. Neon has database branches, which are the proper fix for previews later; until then previews simply have no database, and `/api/health` returning 503 there is the correct behavior.
- **CI and Vercel are independent.** Vercel builds a preview even when CI is red. The protection comes from branch protection on `main`: red code can't be merged, so it can't reach production.
- **Deployment Protection.** Vercel may put a login page in front of some deployments. The board can't log in. After the first production deploy, `curl` the production URL; if you get HTML instead of JSON, look at the project's Deployment Protection settings (names vary by plan) and make sure the production URL the board uses is reachable without a login.
- **Rollback.** In Vercel's Deployments list, an older good deployment can be promoted back to production in one click. Know where that is before you need it.

## 6. What CD does NOT do here: database migrations

Deploying the app does not touch the database. Migrations are still applied by hand (`psql -f`), against Neon. That's deliberate for now: automatic migrations on production deserve their own care (what if one is slow or destructive?).

The rule that keeps this safe: **migrate first, deploy second, and make migrations additive** (new nullable columns and new tables), so the old code keeps working against the new schema during the gap. Removing or renaming a column is a two-step change across two releases.

Later options: a manually triggered workflow (`workflow_dispatch`) that runs pending migrations with a secret, or a migration tool with a tracking table. Not yet.

## 7. What CI does not cover yet

- Firmware: when `firmware/` exists, add a job that runs `pio run` so a compile error can't be merged.
- No lint step yet. ESLint can be added to the `web` job.
- No dependency update bot. Dependabot can open PRs for outdated packages and the same CI will test them.
- No end-to-end test that boots the Next.js server against Postgres. We did that by hand in lesson 2.

## 8. Recap

1. `git push` → GitHub Actions starts a fresh VM, installs from the lockfile, runs typecheck, tests, build, and the SQL migrations on real Postgres.
2. Branch protection stops red code from merging.
3. Vercel's Git integration deploys previews for PRs and production for `main`.
4. Secrets live in Vercel's settings and a password manager. CI needs none.
