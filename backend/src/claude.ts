// Every Claude request of shared-ai goes through ClaudeCaller (ADR-0019): it checks the monthly token budget first,
// and records one ai_usage row per request, also when the request fails. A tool loop calls it once per turn, so each
// call inside the loop is checked too. The key comes from ANTHROPIC_API_KEY, which the deploy script reads from SSM
// (/sirloinbh/shared-ai/anthropic-api-key). Tests pass a fake client; no real key is ever needed.
import Anthropic from '@anthropic-ai/sdk';

import type { Db } from './db.js';
import { monthTokens, recordUsage, type UsageRow } from './usage.js';

/** The one SDK method this service uses, so a fake can stand in for the client in tests. */
export type MessagesClient = {
  messages: { create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message> };
};

/** Where a request comes from, for the usage row. */
export type RequestContext = { conversationId?: string | null; app?: string | null; page?: string | null };

export class BudgetExceededError extends Error {
  readonly used: number;
  readonly limit: number;
  constructor(used: number, limit: number) {
    super('Monthly limit reached: the AI token budget for this month is used up');
    this.used = used;
    this.limit = limit;
  }
}

/** A short code for the usage row; never the message, which can quote the request. */
export function errorCode(err: unknown): string {
  if (err instanceof BudgetExceededError) return 'budget';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.APIConnectionError) return 'connection';
  if (err instanceof Anthropic.APIError) return err.status ? `http_${err.status}` : 'api';
  return 'internal';
}

export type ClaudeCallerOptions = {
  client: MessagesClient;
  db: Db;
  /** AI_MONTHLY_TOKEN_LIMIT */
  monthlyTokenLimit: number;
  now?: () => Date;
  log?: (line: string) => void;
};

export class ClaudeCaller {
  private readonly options: Required<ClaudeCallerOptions>;

  constructor(options: ClaudeCallerOptions) {
    this.options = { now: () => new Date(), log: (line) => console.error(line), ...options };
  }

  /**
   * Throws BudgetExceededError when this month's tokens reached the limit. It is a soft cap below the Console limit:
   * the request that crosses it still finishes, and requests running at the same time are each checked on their own.
   */
  async checkBudget(): Promise<void> {
    const used = await monthTokens(this.options.db, this.options.now());
    if (used >= this.options.monthlyTokenLimit) throw new BudgetExceededError(used, this.options.monthlyTokenLimit);
  }

  /** One Claude request: budget check, the call, and its usage row. */
  async create(params: Anthropic.MessageCreateParamsNonStreaming, context: RequestContext = {}): Promise<Anthropic.Message> {
    await this.checkBudget();
    const started = Date.now();
    const base = { conversationId: context.conversationId ?? null, app: context.app ?? null, page: context.page ?? null };
    let message: Anthropic.Message;
    try {
      message = await this.options.client.messages.create(params);
    } catch (err) {
      await this.record({
        ...base,
        model: params.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: Date.now() - started,
        stopReason: null,
        toolCalls: 0,
        errorCode: errorCode(err),
      });
      throw err;
    }
    const { usage } = message;
    await this.record({
      ...base,
      model: message.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started,
      stopReason: message.stop_reason,
      toolCalls: message.content.filter((b) => b.type === 'tool_use').length,
      errorCode: null,
    });
    return message;
  }

  /** A row that cannot be written is logged; it must not lose a paid answer or hide the request's own error. */
  private async record(row: UsageRow): Promise<void> {
    try {
      await recordUsage(this.options.db, row);
    } catch (err) {
      this.options.log(`claude: usage row not written (${row.model}, ${row.inputTokens + row.outputTokens} tokens): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
