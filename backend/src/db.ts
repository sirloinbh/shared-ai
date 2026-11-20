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
  {
    // #612: the AI shell's chat history, the whole Messages API history of one conversation per row.
    id: '002_chat',
    sql: `
      create table chat_conversations (
        id uuid primary key,
        owner text not null,
        messages jsonb not null default '[]',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index chat_conversations_owner on chat_conversations (owner, updated_at desc);
    `,
  },
];

type Client = Db & { release: () => void };

/** Applies the migrations that have not run yet and returns their IDs. */
export async function migrate(pool: { connect: () => Promise<Client> }): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  // One migrator at a time, even if two containers start together; the lock comes before the first DDL.
  await client.query('select pg_advisory_lock(611)');
  try {
    await client.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
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
  } finally {
    await client.query('select pg_advisory_unlock(611)').catch(() => undefined);
    client.release();
  }
  return applied;
}
