# shared-ai

One AI service for every daysofme app ([ADR-0017](https://github.com/sirloinbh/project-standards/blob/main/docs/adr/0017-ai-service-mcp-and-shell.md), [ADR-0019](https://github.com/sirloinbh/project-standards/blob/main/docs/adr/0019-claude-call-tracking-without-gateway.md)). It runs at `https://ai.daysofme.com` on the shared server, next to the apps.

- **Tool hub.** On start and every 3 minutes it reads each app's tool list from `GET http://<app>-api:<api port>/internal/tools` over the private Docker network `shared-ai`, and calls a tool with `POST /internal/tools/<name>`. An app that does not answer drops out until it answers again. The tools, their scope check, and their audit rows stay in the apps ([docs/ai-tools.md](https://github.com/sirloinbh/project-standards/blob/main/docs/ai-tools.md)).
- **Signed internal calls.** Every call carries a JWT signed here (EdDSA, Ed25519, valid 60 s): `iss` `shared-ai`, `aud` the app, `sub` the owner, `client`, and `scope` (the called app's read and write scopes). Apps check it with the public key. A client's own token is never forwarded.
- **Integrated MCP server.** One MCP server ([`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) v2) lists every app's tools as `<app>__<tool>`, for example `workout_memo__list_workouts`. Stage 1 is stdio over SSH (below).
- **Claude usage.** Every Claude request goes through one caller that first checks the monthly token budget (`AI_MONTHLY_TOKEN_LIMIT`, summed from `ai_usage` for the UTC calendar month) and then writes one `ai_usage` row: conversation, app and page, model, input, output, cache read and cache write tokens, latency, stop reason, tool call count, error code. No prompt or answer text. The AI shell's `POST /api/chat` that uses it comes with project-standards #612.
- Express 5, PostgreSQL 17, Node 24. Tables are created by `dist/migrate.js` before the server starts.

## Endpoints

| Path | What it does |
|---|---|
| `/api/health` | 200 `{ status: "ok", apps: [...] }` with the apps whose tools the hub holds; 503 when the database does not answer |

## Use the tools from Claude Code on the PC (MCP over SSH)

The SSH key is the authentication; load a passphrase key into ssh-agent first. Every call is made for the owner with client `stdio`, and each app writes its own audit row.

```bash
claude mcp add shared-ai -- ssh ubuntu@<server> docker exec -i shared-ai-api-1 node dist/mcp-stdio.js
```

## Registry values

Slot 11 in `sirloinbh/project-standards` `registry/projects.json` (`sharedServices`): web `8111` (published on `127.0.0.1`, forwarded by the server proxy), API `3111` inside the container, DB `15411` (local only).

## Configuration

Every key is in [.env.example](.env.example). On the server the secret values come from AWS SSM (ADR-0014); never write them into the repository, logs, or chat.

| SSM parameter | Variable | Who reads it |
|---|---|---|
| `/sirloinbh/shared-ai/tools-signing-key` | `AI_TOOLS_SIGNING_KEY` (Ed25519 private key, one line with `\n` escapes) | shared-ai; required |
| `/sirloinbh/shared-ai/anthropic-api-key` | `ANTHROPIC_API_KEY` | shared-ai; optional (Claude calls are off without it) |
| `/sirloinbh/shared/ai-tools-public-key` | `AI_TOOLS_PUBLIC_KEY` | each app that serves tools |

## Local run and tests

```bash
cd backend
npm ci
npm test            # tsx --test; fake apps and a fake Claude client, no database, no key
npm run typecheck
```

The MCP test starts the real stdio entry point against a fake app that checks tokens with a copy of the apps' `verifyCallToken`. A full local run needs Docker, a filled `.env`, and the network once: `docker network create shared-ai`, then `docker compose up --build`.

## Server deploy [User]

Before the first deploy: the `ai` DNS record and SSM read access for `shared-ai` (shared-aws-infrastructure), the proxy entry (project-standards `docs/server-proxy.md`, "Changes later"), and the keys in SSM:

```powershell
# On the PC, in the folder that holds both clones
node shared-ai/backend/scripts/signing-key.mjs --public-out ai-public.txt | node project-standards/tools/app-secrets.mjs set /sirloinbh/shared-ai/tools-signing-key
Get-Content ai-public.txt | node project-standards/tools/app-secrets.mjs set /sirloinbh/shared/ai-tools-public-key
Remove-Item ai-public.txt
# A new Claude API key for shared-ai from the Console (ADR-0019), from the clipboard
Get-Clipboard | node project-standards/tools/app-secrets.mjs set /sirloinbh/shared-ai/anthropic-api-key
```

First time, in an `ssh` session on the server:

```bash
sudo install -d -o ubuntu -g ubuntu /opt/shared-ai
git clone https://github.com/sirloinbh/shared-ai.git /opt/shared-ai
cd /opt/shared-ai && bash deploy/deploy.sh
```

`deploy/deploy.sh` creates `.env` with a new DB password on the first run, reads the `@ssm=` keys with the server's reader key, creates the Docker network `shared-ai` when missing, builds and starts the containers under the shared deploy lock, and waits for `/api/health`. Later updates: `cd /opt/shared-ai && bash deploy/deploy.sh`. Then record the memory of `shared-ai-api-1` and `shared-ai-db-1` (`docker stats --no-stream`) in project-standards `docs/costs.md`.

### Automatic deploys and backups

The same timers as shared-auth, installed once as root:

```bash
sudo bash /opt/shared-ai/deploy/install-autodeploy.sh
sudo bash /opt/shared-ai/deploy/install-backup.sh
```

| Timer | What it does |
|---|---|
| `shared-ai-autodeploy` | Every 2 minutes: when `origin/main` moved and every workflow run for that commit passed, moves the checkout to it and runs `deploy/deploy.sh --no-pull`. A failed commit is skipped until the next one (`.autodeploy-failed`). Until CI arrives with the central sync, no commit has a passing run, so it waits |
| `shared-ai-backup` | 03:30 Seoul: `pg_dump` to `/var/backups/ai` (14 days) with row counts, copied to `s3://<backup bucket>/shared-ai/` when `/opt/project-standards/.env` names the bucket |
| `shared-ai-restore-check` | Sunday 04:30 Seoul: restores the newest dump into a throwaway container and compares the row counts |

`deploy/deploy.sh` also dumps the database before each deploy (label `predeploy`). Optional healthchecks.io signals: `HEALTHCHECK_URL_DEPLOY`, `HEALTHCHECK_URL_BACKUP`, and `HEALTHCHECK_URL_RESTORE` in this repo's `.env`. Logs: `journalctl -u shared-ai-autodeploy` (and `-backup`, `-restore-check`).

The database holds only usage rows (and, with #612, chat history). To restore a dump: `gunzip -c /var/backups/ai/<dump>.sql.gz | docker exec -i shared-ai-db-1 psql -U ai -d ai` into an empty database.
