import { Pool } from "pg";

// One pool per server process, remembered on globalThis. In `next dev` modules are reloaded on every edit, and
// without this each reload would leak a new pool and eventually hit the database's connection limit.
// On Vercel each function instance has its own pool, so keep it tiny: the database sees (instances x max).
// Neon's pooled connection string (host contains "-pooler") puts PgBouncer in front and absorbs the rest.
const g = globalThis as unknown as { __ainaPool?: Pool };

export function getPool(): Pool {
  if (!g.__ainaPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__ainaPool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
  }
  return g.__ainaPool;
}
