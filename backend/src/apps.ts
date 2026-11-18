// The apps the hub asks for tools: every active app in project-standards registry/projects.json, at its API
// container on the private Docker network `shared-ai` (alias `<app>-api`, port = the registry `ports.api`). An app
// that has not joined the network yet simply does not answer and stays out of the tool list.

export type AppTarget = { name: string; url: string };

const REGISTRY: readonly [string, number][] = [
  ['workout-memo', 3101],
  ['study-log', 3102],
  ['health-log', 3103],
  ['life-journal', 3104],
  ['money-ledger', 3105],
  ['cert-manager', 3106],
  ['plan-routine', 3107],
  ['dev-career-portfolio', 3108],
];

const APP_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The registry apps, or the list in AI_TOOL_APPS (`name=url,name=url`), for local runs and tests. A bad entry is an
 * error at start, not a silent skip.
 */
export function toolApps(env: NodeJS.ProcessEnv = process.env): AppTarget[] {
  const override = env.AI_TOOL_APPS?.trim();
  if (!override) return REGISTRY.map(([name, port]) => ({ name, url: `http://${name}-api:${port}` }));
  return override.split(',').map((entry) => {
    const [name, url] = entry.split('=').map((s) => s.trim());
    if (!name || !APP_NAME.test(name) || !url || !/^https?:\/\//.test(url)) throw new Error(`AI_TOOL_APPS: bad entry "${entry}" (use name=http://host:port)`);
    return { name, url: url.replace(/\/+$/, '') };
  });
}
