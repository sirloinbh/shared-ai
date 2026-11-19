// The tool hub (ADR-0017): reads each app's tool list from GET <app>/internal/tools over the private Docker network
// `shared-ai` on start and every few minutes, and calls a tool with POST <app>/internal/tools/<name>. An app that does
// not answer drops out of the list until it answers again. The contract is the managed file
// backend/src/standard/tools.ts in each app (docs/ai-tools.md in project-standards).
import type { AppTarget } from './apps.js';
import { LIST_TOOL, type Signer } from './signing.js';

export type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean };

/** One app tool as the app lists it. */
export type AppTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: string;
  annotations: ToolAnnotations;
};

/** A tool under the hub's name `<app>__<tool>`, with the app prefix in snake_case. */
export type HubTool = AppTool & { app: string; tool: string };

/** Who the hub calls for: the owner, the client (`stdio`, `ai-shell`, an MCP client ID), and the granted scopes. */
export type CallContext = { client: string; scopes?: readonly string[] };

export class ToolCallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const APP_TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const LIST_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 30_000;
// The scope string an app sends for each tool: `<app>:read` or `<app>:write`.
const scopeOf = (app: string) => new RegExp(`^${app.replace(/[-]/g, '\\-')}:(read|write)$`);

/** `workout-memo` and `list_workouts` give `workout_memo__list_workouts`. */
export function hubToolName(app: string, tool: string) {
  return `${app.replace(/-/g, '_')}__${tool}`;
}

/** Checks one app's list answer and returns its tools, or throws with the reason. */
export function parseToolList(app: string, body: unknown): AppTool[] {
  if (typeof body !== 'object' || body === null) throw new Error('the answer is not a JSON object');
  const { app: listed, tools } = body as { app?: unknown; tools?: unknown };
  if (listed !== app) throw new Error(`the answer is for app ${JSON.stringify(listed)}`);
  if (!Array.isArray(tools)) throw new Error('tools is not a list');
  return tools.map((t: unknown, i) => {
    const tool = (t ?? {}) as Partial<AppTool>;
    if (typeof tool.name !== 'string' || !APP_TOOL_NAME.test(tool.name)) throw new Error(`tool ${i} has an invalid name`);
    if (typeof tool.description !== 'string') throw new Error(`${tool.name}: description is missing`);
    if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null || Array.isArray(tool.inputSchema)) {
      throw new Error(`${tool.name}: inputSchema is not an object`);
    }
    if (typeof tool.scope !== 'string' || !scopeOf(app).test(tool.scope)) throw new Error(`${tool.name}: scope is not ${app}:read or ${app}:write`);
    const annotations = tool.annotations ?? { readOnlyHint: false, destructiveHint: false };
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      scope: tool.scope,
      annotations: { readOnlyHint: annotations.readOnlyHint === true, destructiveHint: annotations.destructiveHint === true },
    };
  });
}

type Fetch = typeof fetch;

export type HubOptions = {
  apps: readonly AppTarget[];
  signer: Signer;
  /** The owner every call acts for (the shared sign-in user ID). */
  owner: string;
  fetch?: Fetch;
  log?: (line: string) => void;
};

export class ToolHub {
  private readonly options: Required<HubOptions>;
  private byApp = new Map<string, HubTool[]>();
  private byName = new Map<string, HubTool>();
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(options: HubOptions) {
    this.options = { fetch: globalThis.fetch, log: (line) => console.error(line), ...options };
  }

  /** Every tool of every app that answered at the last refresh, sorted by name. */
  list(): HubTool[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The apps that answered at the last refresh. */
  apps(): string[] {
    return [...this.byApp.keys()].sort();
  }

  get(name: string): HubTool | undefined {
    return this.byName.get(name);
  }

  /** Called after a refresh changed the tool list (MCP `notifications/tools/list_changed`). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reads every app's list once. An app that fails is dropped; the others stay. A refresh that is still running is
   * joined, so an older answer never overwrites a newer one.
   */
  refresh(): Promise<void> {
    this.running ??= this.readAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private running: Promise<void> | undefined;

  private async readAll(): Promise<void> {
    const before = this.signature();
    const results = await Promise.all(this.options.apps.map(async (app) => [app.name, await this.listApp(app)] as const));
    const byApp = new Map<string, HubTool[]>();
    for (const [name, tools] of results) if (tools) byApp.set(name, tools);
    this.byApp = byApp;
    this.byName = new Map([...byApp.values()].flat().map((t) => [t.name, t]));
    if (this.signature() === before) return;
    for (const listener of this.listeners) {
      // One failing listener must not stop the others or fail the refresh.
      try {
        listener();
      } catch (err) {
        this.options.log(`hub: change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Refreshes now and then every `intervalMs`. */
  async start(intervalMs: number): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh().catch((err: unknown) => this.options.log(`hub: refresh failed: ${String(err)}`)), intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /**
   * Calls a hub tool for the owner. The token names this client and grants only the scope this tool needs, and only
   * when the caller holds it (default: every scope); the app still checks the scope and writes the audit row.
   */
  async call(name: string, input: unknown, context: CallContext): Promise<unknown> {
    const tool = this.byName.get(name);
    if (!tool) throw new ToolCallError(404, `Unknown tool ${name}`);
    const app = this.options.apps.find((a) => a.name === tool.app);
    if (!app) throw new ToolCallError(404, `Unknown app ${tool.app}`);
    const scopes = !context.scopes || context.scopes.includes(tool.scope) ? [tool.scope] : [];
    const token = this.options.signer.sign({ app: app.name, owner: this.options.owner, client: context.client, scopes, tool: tool.tool });
    let response: Response;
    try {
      response = await this.options.fetch(`${app.url}/internal/tools/${encodeURIComponent(tool.tool)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input ?? {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ToolCallError(503, `${app.name} did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await response.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    if (!response.ok) {
      const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
      throw new ToolCallError(response.status, `${app.name}: ${message}`);
    }
    return body?.result ?? null;
  }

  private async listApp(app: AppTarget): Promise<HubTool[] | null> {
    try {
      const token = this.options.signer.sign({ app: app.name, owner: this.options.owner, client: 'shared-ai', scopes: [], tool: LIST_TOOL });
      const response = await this.options.fetch(`${app.url}/internal/tools`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tools = parseToolList(app.name, await response.json());
      return tools.map((t) => ({ ...t, app: app.name, tool: t.name, name: hubToolName(app.name, t.name) }));
    } catch (err) {
      // Most apps are not on the network yet; log only when an app that answered before stops answering.
      if (this.byApp.has(app.name)) this.options.log(`hub: ${app.name} dropped: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private signature() {
    return JSON.stringify(this.list().map((t) => [t.name, t.description, t.inputSchema, t.annotations]));
  }
}
