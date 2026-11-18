# shared-ai Project Instructions

These rules apply to this repo only. The common procedure is in [AGENTS.md](AGENTS.md) (arrives with the central sync); if the two files differ, this file wins.

## What this repo is

- The shared AI service ([ADR-0017](https://github.com/sirloinbh/project-standards/blob/main/docs/adr/0017-ai-service-mcp-and-shell.md), [ADR-0019](https://github.com/sirloinbh/project-standards/blob/main/docs/adr/0019-claude-call-tracking-without-gateway.md)): the tool hub over each app's `/internal/tools`, the integrated MCP server, and the Claude caller with the `ai_usage` table and the monthly budget guard. Express 5, `pg`, PostgreSQL 17, `@modelcontextprotocol/server` v2, `@anthropic-ai/sdk`. It is not an app: no frontend and no domain data.
- The Node project is in `backend/` (there is no root `package.json`). `compose.yaml`, `deploy/deploy.sh`, and `.env.example` are at the repo root. [README.md](README.md) lists the endpoints, ports, keys, and the deploy; keep it in step with behavior changes.

## Verification commands

Run them in `backend/` before committing and before creating or updating a PR, and record the results in the PR.

| Command | When |
|---|---|
| `npm ci` | First, when `node_modules` is missing (installs exactly what the lockfile says) |
| `npm run typecheck` | Always (sources and tests) |
| `npm test` | Always (fake apps and a fake Claude client; no database, no key, no network) |
| `npm run build` | When you change the build, `tsconfig.json`, or the `Dockerfile` |
| `bash -n deploy/*.sh` | When you change a deploy script |

## Rules for this repo

- The app side of the tool contract is the managed file `templates/app/backend/src/standard/tools.ts` in project-standards. `test/fake-app.ts` holds a copy of its `verifyCallToken`; when that file changes, update the copy (and this service) in the same change. A change to the token or the routes is a central PR first.
- Never forward a client's token to an app (no token passthrough). Each app call carries a token signed here for that one app.
- Every Claude request goes through `ClaudeCaller` (budget check first, one `ai_usage` row after). Do not call the SDK directly, and do not store prompt or answer text in `ai_usage`.
- Tests never use a real Claude key or a real app. Never write secret values (the signing key, the Claude key, the DB password, SSM keys) into the repo, logs, PRs, or chat. `.env.example` lists only the keys.
- Pin dependencies to exact versions (`backend/.npmrc` has `save-exact` and `ignore-scripts`). Adding or raising a dependency follows project-standards `docs/dependency-policy.md`.
- The port slot (web `8111`, API `3111`, DB `15411`) and the app list in `src/apps.ts` come from `registry/projects.json` in project-standards. To change the slot, open an issue there.

## Merging and deploying

- Merging to `main` deploys once the user has installed `deploy/install-autodeploy.sh` on the server: the timer deploys a commit after its CI passed. Before that, the user deploys by hand (`bash deploy/deploy.sh`, see the README). The agent does not run the deploy, does not touch the server, and does not change the production database. If a change needs a deploy, say so in "Check before merging".
