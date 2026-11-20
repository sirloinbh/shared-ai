// A Claude conversation turn that can call the hub's tools (the core of the AI shell, #612). Every Claude request in
// the loop goes through ClaudeCaller, so the monthly budget is checked before each one and each one leaves a usage
// row. A tool that is not read-only runs only when `approve` says yes (the shell asks the owner).
import type Anthropic from '@anthropic-ai/sdk';

import type { ClaudeCaller, RequestContext } from './claude.js';
import type { HubTool, ToolHub } from './hub.js';
import { ToolCallError } from './hub.js';

const CLAUDE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The hub's tools in the Messages API shape. */
export function claudeTools(tools: readonly HubTool[]): Anthropic.Tool[] {
  return tools
    .filter((t) => CLAUDE_TOOL_NAME.test(t.name))
    .map((t) => {
      // `$schema` is metadata for validators; the tool definition needs only the schema itself.
      const { $schema: _ignored, ...schema } = t.inputSchema;
      return { name: t.name, description: `[${t.app}] ${t.description}`, input_schema: { type: 'object', ...schema } as Anthropic.Tool.InputSchema };
    });
}

export type ToolLoopHooks = {
  /** Every Claude answer, as it arrives. */
  onMessage?: (message: Anthropic.Message) => void;
  /** A known tool is about to run (after this, a tool that changes data waits for `approve`). */
  onToolCall?: (use: Anthropic.ToolUseBlock, tool: HubTool) => void;
  /** The tool's result, or the reason it did not run. */
  onToolResult?: (use: Anthropic.ToolUseBlock, result: Anthropic.ToolResultBlockParam) => void;
};

export type ToolLoopOptions = {
  caller: ClaudeCaller;
  hub: ToolHub;
  /** model, max_tokens, system, and the conversation so far (ending with the owner's message). */
  request: Omit<Anthropic.MessageCreateParamsNonStreaming, 'tools'>;
  context: RequestContext & { client: string };
  /** Asked before a tool that is not read-only runs; `id` is Claude's tool_use ID. */
  approve: (tool: HubTool, input: unknown, id: string) => Promise<boolean>;
  /** Optional observers, for streaming the turn to the AI shell. They run in order and must not throw. */
  hooks?: ToolLoopHooks;
  /** Claude requests at most per turn (default 10). */
  maxRequests?: number;
};

/** Runs Claude and the tools it asks for until Claude stops asking. Returns the last message and the full history. */
export async function runToolLoop(options: ToolLoopOptions): Promise<{ message: Anthropic.Message; messages: Anthropic.MessageParam[] }> {
  const { caller, hub, context, approve } = options;
  const messages: Anthropic.MessageParam[] = [...options.request.messages];
  const tools = claudeTools(hub.list());
  const maxRequests = options.maxRequests ?? 10;
  for (let i = 0; ; i++) {
    const message = await caller.create({ ...options.request, messages, ...(tools.length ? { tools } : {}) }, context);
    // The whole content goes back, thinking blocks included, so the next request continues the same turn.
    messages.push({ role: 'assistant', content: message.content });
    options.hooks?.onMessage?.(message);
    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (message.stop_reason !== 'tool_use' || uses.length === 0) return { message, messages };
    if (i + 1 >= maxRequests) {
      // Every tool_use needs a tool_result, or the stored conversation cannot continue.
      messages.push({
        role: 'user',
        content: uses.map((use) => ({ type: 'tool_result', tool_use_id: use.id, content: 'Stopped: too many steps in one turn.', is_error: true })),
      });
      return { message, messages };
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) results.push(await runTool(hub, use, context.client, approve, options.hooks));
    // All results in one user message, so parallel calls stay parallel.
    messages.push({ role: 'user', content: results });
  }
}

async function runTool(
  hub: ToolHub,
  use: Anthropic.ToolUseBlock,
  client: string,
  approve: ToolLoopOptions['approve'],
  hooks?: ToolLoopHooks,
): Promise<Anthropic.ToolResultBlockParam> {
  const done = (result: Anthropic.ToolResultBlockParam) => {
    hooks?.onToolResult?.(use, result);
    return result;
  };
  const fail = (text: string) => done({ type: 'tool_result', tool_use_id: use.id, content: text, is_error: true });
  const tool = hub.get(use.name);
  if (!tool) return fail(`Unknown tool ${use.name}`);
  hooks?.onToolCall?.(use, tool);
  if (!tool.annotations.readOnlyHint && !(await approve(tool, use.input, use.id))) return fail('The owner did not allow this change.');
  try {
    const result = await hub.call(use.name, use.input, { client });
    return done({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
  } catch (err) {
    return fail(err instanceof ToolCallError ? err.message : 'The tool call failed.');
  }
}
