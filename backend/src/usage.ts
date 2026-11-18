// Claude usage records and the monthly budget (ADR-0019). Each Claude request leaves one ai_usage row with the token
// counts from the response's `usage`; the budget guard sums this month's rows before every request.
import type { Db } from './db.js';

export type UsageRow = {
  conversationId: string | null;
  app: string | null;
  page: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  stopReason: string | null;
  toolCalls: number;
  errorCode: string | null;
};

export async function recordUsage(db: Db, row: UsageRow): Promise<void> {
  await db.query(
    `insert into ai_usage (conversation_id, app, page, model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, latency_ms, stop_reason, tool_calls, error_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.conversationId,
      row.app,
      row.page,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.latencyMs,
      row.stopReason,
      row.toolCalls,
      row.errorCode,
    ],
  );
}

/** The first moment of the calendar month (UTC, like the Console's billing) that holds `now`. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** All tokens of this month's requests: input, output, cache read, and cache write. */
export async function monthTokens(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query<{ total: string | null }>(
    `select sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)::text as total
       from ai_usage where created_at >= $1`,
    [monthStart(now)],
  );
  return Number(rows[0]?.total ?? 0);
}
