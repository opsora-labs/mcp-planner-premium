# Autonomous development setup

This guide explains how to configure the project so Claude Code can develop,
test, and call the live Planner Premium API without human interaction. You
complete a one-time setup; after that, Claude handles the rest.

## How it works

```
You (once)                          Claude (every autonomous session)
-----------                         ----------------------------------
1. Configure Entra app              1. Read TODO.md — pick next task
2. Add env vars to .env             2. Create a feature branch
3. Run auth-login.ts                3. Implement + typecheck + unit test
   → .tokens.json is written        4. Get a token silently:
                                       get-dataverse-token.ts reads
4. Start Claude:                       .tokens.json, calls Entra,
   claude --dangerously-skip-          outputs a fresh access token
   permissions                      5. Run e2e against the live API
                                    6. Open PR → auto-merge
                                    7. Check off task in TODO.md
                                    8. Repeat
```

The token cache (`.tokens.json`) is gitignored and lives only on your machine.
Refresh tokens rotate silently on every use and stay valid for 90 days of
non-use. Any successful refresh resets the clock.

---

## Prerequisites

### Microsoft 365 license

The PSS V2 APIs that Planner Premium is built on require the calling user to hold
a **Project Plan P3** or **Planner Premium** license. You sign in as that licensed
user during setup; Claude inherits that context via the refresh token.

Service principals cannot hold M365 licenses, which is why app-only
(client-credentials) auth does not work for PSS write operations.

### Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude --version   # confirm it is on your PATH
```

---

## Step 1 - Entra app registration

Open [Entra admin center](https://entra.microsoft.com) and go to
**App registrations**. You can use an existing registration or create a new one.

### API permissions

1. Go to **API permissions** on your app.
2. Click **Add a permission**.
3. Choose **Dynamics CRM**.
4. Select **Delegated permissions** - **user_impersonation**.
5. Click **Add permissions**.
6. Click **Grant admin consent for [your tenant]** and confirm.

### Allow public client flows

1. Go to **Authentication** on your app.
2. Scroll to **Advanced settings**.
3. Set **Allow public client flows** to **Yes**.
4. Click **Save**.

This setting is required for the device-code login used in `auth-login.ts`.

### Client secret (optional but recommended)

A client secret binds the refresh token to this specific app instance, which
prevents it from being used if extracted without the secret.

1. Go to **Certificates & secrets**.
2. Click **New client secret**.
3. Copy the **Value** (shown only once).

---

## Step 2 - Environment variables

Add the following to your `.env` file in the project root. The file is gitignored.

```bash
# Required
TENANT_ID=<your-entra-tenant-guid>
ENTRA_CLIENT_ID=<your-app-registration-client-id>
DATAVERSE_ORG_URL=https://your-org.crm.dynamics.com

# Optional but recommended — binds the refresh token to this client
ENTRA_CLIENT_SECRET=<client-secret-value>
```

`DATAVERSE_LINK_TYPE_STYLE` is also required by the server (`global` or `eu`).
See the main README for how to determine which one applies to your tenant.

---

## Step 3 - Sign in once

Run the login script. It starts a device-code flow, prompts you to visit a URL
and enter a short code, then caches the resulting refresh token to `.tokens.json`.

```bash
npx tsx --env-file .env scripts/auth-login.ts
```

You will see output like:

```
============================================================
To sign in, use a web browser to open the page
https://microsoft.com/devicelogin and enter the code ABCD1234
to authenticate.
============================================================

Waiting for you to complete sign-in…
```

Open the URL, enter the code, and sign in with an account that holds a
**Project Plan P3 or Planner Premium license**. After you authenticate, the
terminal prints:

```
Signed in. Refresh token cached to .tokens.json
Claude can now run autonomous sessions without further interaction.
```

You do not need to repeat this step unless the token expires (90 days of
non-use) or you revoke it.

---

## Step 4 - Hand off to Claude

Start an autonomous session from the project directory:

```bash
cd /path/to/mcp-planner-premium
claude --dangerously-skip-permissions
```

The `--dangerously-skip-permissions` flag removes the per-operation approval
prompts. The safety hooks defined in `.claude/hooks/` still run regardless of
this flag:

- `block-dangerous-bash.mjs` - blocks force-push, push to main, `--no-verify`,
  `rm -rf` outside build paths, `npm publish`, and `.env` writes.
- `protect-paths.mjs` - blocks edits to `.env*`, `package-lock.json`,
  `.claude/settings.json`, and `.claude/hooks/*`.
- `verify-on-stop.mjs` - runs `npm run typecheck` and `npm test` at the end of
  every turn that touched `src/` or `test/`; refuses to finish while they are red.

Claude will read `TODO.md`, pick the first unchecked item, implement it on a
branch, run tests, open a PR, merge it, and check off the item - then move to
the next one.

---

## How Claude gets tokens during a session

Before each e2e run, Claude calls:

```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
```

`get-dataverse-token.ts` reads `.tokens.json`, exchanges the refresh token for a
fresh Dataverse access token via Entra, writes the rotated refresh token back to
`.tokens.json`, and prints only the access token to stdout. No secrets appear in
logs.

If token refresh fails (the cache has expired or was revoked), the script exits
with an error message telling Claude to stop and ask you to re-run `auth-login.ts`.

---

## Cleaning up e2e test plans

Each write-phase e2e run creates a plan named `ZZ-MCP-E2E-<timestamp>` in
Dataverse. Whole-plan deletion is blocked at the server level by design, so these
plans are not removed automatically. Clean them up with:

```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
npx tsx --env-file .env scripts/cleanup-e2e-plans.ts
```

The cleanup script queries Dataverse directly (bypassing the MCP server) and
deletes all matching plans. It prints a summary of what was deleted.

---

## Troubleshooting

**`zsh: command not found: claude`**
Install the CLI: `npm install -g @anthropic-ai/claude-code`

**`No .tokens.json found`**
Run `npx tsx --env-file .env scripts/auth-login.ts` to sign in.

**`Token refresh failed (400)`**
The refresh token has expired or was revoked. Re-run `auth-login.ts`.

**`Authorization_RequestDenied` from Dataverse during e2e**
The signed-in user lacks a Project Plan P3 / Planner Premium license, or the
Entra app is missing admin-consented `user_impersonation` on Dynamics CRM.

**`AADSTS7000218: The request body must contain... client_secret`**
Your Entra app requires a client secret for token operations. Add
`ENTRA_CLIENT_SECRET` to your `.env`.

**`allow public client flows` error during device code**
In Entra admin center, go to the app's Authentication tab and set
**Allow public client flows** to **Yes**.

---

## Task backlog

`TODO.md` at the project root contains the backlog Claude works through. Items
are standard markdown checkboxes:

```markdown
- [ ] Pending task
- [x] Completed task
```

Add new items at the bottom of the relevant section. Claude picks the first
unchecked item on each run, so ordering matters.
