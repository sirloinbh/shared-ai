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

First install, in order. Each step says where to run it and what success looks like. `server-ssh` and `server-ip` are the project-standards tools (`tools/install.ps1`, then a new terminal); they connect to the server without a typed address. Keep every `server-ssh` command on one line and free of double quotes (Windows PowerShell 5.1 drops them).

### 1. DNS record and SSM read access (PC)

In `D:\github\shared-aws-infrastructure`, on updated main:

```powershell
terraform plan "-out=ai.tfplan"
terraform apply ai.tfplan
Resolve-DnsName ai.daysofme.com -Type A
```

- The plan must say `Plan: 1 to add, 2 to change, 0 to destroy`: the `ai` DNS record, the server reader policy (adds the `/sirloinbh/shared-ai/*` path), and the IAM user `study_log_files`. The last one **removes a tag that was added by hand in the console** (its key is an access key ID); it is a label only, but it is a change you did not type. Anything to destroy or replace: stop.
- Success: `Resolve-DnsName` answers the same address as `server-ip`.

### 2. Keys in SSM (PC)

Use the AWS profile that can write SSM (`$env:SIRLOINBH_AWS_PROFILE`). First list the missing names (names only, no values):

```powershell
aws ssm get-parameters --names /sirloinbh/shared-ai/tools-signing-key /sirloinbh/shared-ai/anthropic-api-key /sirloinbh/shared/ai-tools-public-key --query InvalidParameters --profile <profile> --region ap-northeast-2
```

`[]` means all three exist. Create only the ones listed, in the folder that holds both clones:

```powershell
node shared-ai/backend/scripts/signing-key.mjs --public-out ai-public.txt | node project-standards/tools/app-secrets.mjs set /sirloinbh/shared-ai/tools-signing-key
Get-Content ai-public.txt | node project-standards/tools/app-secrets.mjs set /sirloinbh/shared/ai-tools-public-key
Remove-Item ai-public.txt
# Optional (Claude calls stay off without it): a new Claude API key for shared-ai from the Console (ADR-0019), from the clipboard
Get-Clipboard | node project-standards/tools/app-secrets.mjs set /sirloinbh/shared-ai/anthropic-api-key
```

Success: the list command prints `[]` or only `anthropic-api-key`. Only `tools-signing-key` is `@required`; the deploy stops without it.

#### No SSM permission on the PC: use the AWS console

The CLI path above needs an AWS profile with `ssm:GetParameter` and `ssm:PutParameter` (and `ssm:GetParameters`) on `/sirloinbh/*`. If the only profile on the PC is the Terraform one (`workout-personal`), it has none of those; use the console instead, signed in as the account owner.

1. **Check the names.** Console, region **Asia Pacific (Seoul) ap-northeast-2**, Systems Manager, Parameter Store, My parameters. Search `/sirloinbh/shared-ai` and `/sirloinbh/shared/ai-tools`. You need `/sirloinbh/shared-ai/tools-signing-key`, `/sirloinbh/shared/ai-tools-public-key` and (optional) `/sirloinbh/shared-ai/anthropic-api-key`. Do not open a value to check it; a name in the list is enough.
2. **Make the key pair on the PC without printing it**, in the folder that holds both clones:

   ```powershell
   node shared-ai/backend/scripts/signing-key.mjs --public-out ai-public.txt > ai-private.txt
   ```

   Both files hold one line with `\n` escapes (not real line breaks); that is the format the server expects.
3. **Create the private key.** Create parameter: Name `/sirloinbh/shared-ai/tools-signing-key`, Tier Standard, Type **SecureString**, KMS key source "My current account", the default `alias/aws/ssm`. Value: put the file in the clipboard with `Get-Content ai-private.txt -Raw | Set-Clipboard`, paste it into the Value box, and check it is one line that starts with five dashes and `BEGIN PRIVATE KEY` (the same as the public key below, with `PUBLIC`). Create parameter.
4. **Create the public key** the same way: Name `/sirloinbh/shared/ai-tools-public-key`, Type SecureString, Value from `Get-Content ai-public.txt -Raw | Set-Clipboard` (one line starting with `-----BEGIN PUBLIC KEY-----\n`).
5. **Optional Claude key**: Name `/sirloinbh/shared-ai/anthropic-api-key`, Type SecureString, Value the new key from the Console (ADR-0019).
6. **Delete the local files and clear the clipboard**:

   ```powershell
   Remove-Item ai-private.txt, ai-public.txt
   Set-Clipboard -Value ' '
   ```

Success: the two required names appear in My parameters with type SecureString. Run it once: a second pair would sign with a key the apps do not trust, because the apps read the public key from SSM.

### 3. Proxy entry (PC)

In `project-standards`, on updated main (the generated config already has `ai.daysofme.com` -> `127.0.0.1:8111`):

```powershell
node scripts/proxy-config.mjs
$k = "$HOME/.ssh/workout-memo-lightsail"; $s = "ubuntu@$(server-ip)"
scp -i $k .local/proxy/nginx/apps.conf "${s}:/tmp/apps.conf"
server-ssh sudo cp /tmp/apps.conf /opt/project-standards/proxy/nginx/apps.conf
server-ssh cd /opt/project-standards/proxy && sudo bash cert.sh reload
```

Success: the reload prints no error (it runs `nginx -t` first and does not reload a broken config). The wildcard certificate already covers `ai`.

### 4. First deploy (server: `server-ssh`)

```bash
sudo install -d -o ubuntu -g ubuntu /opt/shared-ai
git clone https://github.com/sirloinbh/shared-ai.git /opt/shared-ai
cd /opt/shared-ai && bash deploy/deploy.sh
```

`deploy/deploy.sh` creates `.env` with a new DB password on the first run (`deploy/bootstrap-env.sh`), reads the `@ssm=` keys with the server's reader key, creates the Docker network `shared-ai` when missing, builds and starts the containers under the shared deploy lock, and waits for `/api/health`. Later updates: `cd /opt/shared-ai && bash deploy/deploy.sh` (it fast-forwards to `origin/main` first; `--no-pull` deploys the current checkout).

Success:

- It prints `deploy: created .env with a new DB password` (first run only) and `deployed <12 characters>`, and no `could not read ... @required` line. On `health check failed`, stop and look at `docker compose logs --tail 50 api` (do not paste `.env`).
- `curl -fsS http://127.0.0.1:8111/api/health` prints `{"status":"ok"}`.
- `cat .deployed` equals `git rev-parse --short=12 HEAD`.
- `docker ps --format '{{.Names}} {{.Status}}'` shows `shared-ai-api-1` Up and `shared-ai-db-1` Up (healthy).

### 5. Automatic deploys and backups (server)

```bash
sudo bash /opt/shared-ai/deploy/install-autodeploy.sh
sudo bash /opt/shared-ai/deploy/install-backup.sh
```

Success: both list their timers (table below). After 2 to 3 minutes `journalctl -u shared-ai-autodeploy -n 20 --no-pager` shows no error.

### 6. Public check (PC, from an allowed IP)

```powershell
curl.exe -sS -o NUL -w "%{http_code}`n" https://ai.daysofme.com/api/health
```

Success: `200`. `502` means nothing listens on 8111 (step 4); a timeout means DNS (step 1) or the firewall.

### 7. Record the memory

`docker stats --no-stream` on the server: record the memory of `shared-ai-api-1` and `shared-ai-db-1` in project-standards `docs/costs.md`.

### Automatic deploys and backups: what the timers do

| Timer | What it does |
|---|---|
| `shared-ai-autodeploy` | Every 2 minutes: when `origin/main` moved and every workflow run for that commit passed, moves the checkout to it and runs `deploy/deploy.sh --no-pull`. A failed commit is skipped until the next one (`.autodeploy-failed`). Until CI arrives with the central sync, no commit has a passing run, so it waits |
| `shared-ai-backup` | 03:30 Seoul: `pg_dump` to `/var/backups/ai` (14 days) with row counts, copied to `s3://<backup bucket>/shared-ai/` when `/opt/project-standards/.env` names the bucket |
| `shared-ai-restore-check` | Sunday 04:30 Seoul: restores the newest dump into a throwaway container and compares the row counts |

`deploy/deploy.sh` also dumps the database before each deploy (label `predeploy`). Optional healthchecks.io signals: `HEALTHCHECK_URL_DEPLOY`, `HEALTHCHECK_URL_BACKUP`, and `HEALTHCHECK_URL_RESTORE` in this repo's `.env`. Logs: `journalctl -u shared-ai-autodeploy` (and `-backup`, `-restore-check`).

The database holds only usage rows (and, with #612, chat history). To restore a dump: `gunzip -c /var/backups/ai/<dump>.sql.gz | docker exec -i shared-ai-db-1 psql -U ai -d ai` into an empty database.
