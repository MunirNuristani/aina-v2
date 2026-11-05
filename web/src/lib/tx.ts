// Anything with a pg-style query(): a pg PoolClient, or PGlite in the tests.
export type Queryable = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

// BEGIN ... COMMIT, with ROLLBACK if anything throws. `q` MUST be one single connection (a client checked out
// of the pool), never the pool itself: the pool may send BEGIN and the next statement down different connections,
// and then there is no transaction at all.
export async function runInTransaction<T>(q: Queryable, fn: () => Promise<T>): Promise<T> {
  await q.query("begin");
  try {
    const result = await fn();
    await q.query("commit");
    return result;
  } catch (err) {
    try {
      await q.query("rollback");
    } catch {
      // the connection is probably gone; the original error matters more
    }
    throw err;
  }
}
