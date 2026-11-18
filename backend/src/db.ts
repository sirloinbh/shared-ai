// Schema of the shared-ai database. Each migration runs once, in order, inside a transaction; applied ones are
// recorded in schema_migrations. Never edit an applied migration; add a new one.

/** The part of a pg Pool or client this service uses, so tests can pass a fake. */
export type Db = { query: <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[] }> };

export const MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    // ADR-0019: one row per Claude request. No prompt or answer text here.
    id: '001_ai_usage',
    sql: `
      create table ai_usage (
        id bigint generated always as identity primary key,
        created_at timestamptz not null default now(),
        conversation_id text,
        app text,
        page text,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        latency_ms integer not null,
        stop_reason text,
        tool_calls integer not null default 0,
        error_code text
      );
      create index ai_usage_created_at on ai_usage (created_at);
    `,
  },
];

type Client = Db & { release: () => void };

/** Applies the migrations that have not run yet and returns their IDs. */
export async function migrate(pool: { connect: () => Promise<Client> }): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
    // One migrator at a time, even if two containers start together.
    await client.query('select pg_advisory_lock(611)');
    const done = new Set((await client.query<{ id: string }>('select id from schema_migrations')).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into schema_migrations (id) values ($1)', [m.id]);
        await client.query('commit');
        applied.push(m.id);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
    await client.query('select pg_advisory_unlock(611)');
  } finally {
    client.release();
  }
  return applied;
}
