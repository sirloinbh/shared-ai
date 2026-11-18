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

export type ToolLoopOptions = {
  caller: ClaudeCaller;
  hub: ToolHub;
  /** model, max_tokens, system, and the conversation so far (ending with the owner's message). */
  request: Omit<Anthropic.MessageCreateParamsNonStreaming, 'tools'>;
  context: RequestContext & { client: string };
  /** Asked before a tool that is not read-only runs. */
  approve: (tool: HubTool, input: unknown) => Promise<boolean>;
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
    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (message.stop_reason !== 'tool_use' || uses.length === 0 || i + 1 >= maxRequests) return { message, messages };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) results.push(await runTool(hub, use, context.client, approve));
    // All results in one user message, so parallel calls stay parallel.
    messages.push({ role: 'user', content: results });
  }
}

async function runTool(
  hub: ToolHub,
  use: Anthropic.ToolUseBlock,
  client: string,
  approve: ToolLoopOptions['approve'],
): Promise<Anthropic.ToolResultBlockParam> {
  const fail = (text: string): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: use.id, content: text, is_error: true });
  const tool = hub.get(use.name);
  if (!tool) return fail(`Unknown tool ${use.name}`);
  if (!tool.annotations.readOnlyHint && !(await approve(tool, use.input))) return fail('The owner did not allow this change.');
  try {
    const result = await hub.call(use.name, use.input, { client });
    return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) };
  } catch (err) {
    return fail(err instanceof ToolCallError ? err.message : 'The tool call failed.');
  }
}
