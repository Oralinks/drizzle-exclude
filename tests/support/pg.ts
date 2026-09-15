import pg from 'pg';

/** SQLSTATE PostgreSQL sends to open connections when the server shuts down, as a test container does on stop. */
const ADMIN_SHUTDOWN = '57P01';

/**
 * A `pg` pool for database tests. `pool.end()` can resolve before every client has finished
 * disconnecting, so stopping the container straight afterwards can deliver `57P01` to a client
 * with no error listener, which crashes the test run. That shutdown error is expected during
 * teardown and ignored. Any other connection error is rethrown, so it still fails the run.
 */
export function testPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  const ignoreShutdown = (error: Error & { code?: string }) => {
    if (error.code !== ADMIN_SHUTDOWN) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  pool.on('error', ignoreShutdown);
  pool.on('connect', (client) => client.on('error', ignoreShutdown));
  return pool;
}
