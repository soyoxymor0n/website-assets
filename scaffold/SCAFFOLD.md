# Project Scaffold Cheatsheet

> **Living document** — update this when a service's API changes, a step gets automated, or you discover a better order.
> Lives in `website-assets/` root so it's always one `git pull` away.

---

## Two-skill system

This infra scaffold pairs with a **code scaffold** skill that generates the actual codebase (folder structure, `package.json` with pinned deps, boilerplate files). They're designed to run in sequence for a net-new project:

```
Step 1 — Code scaffold   → generates repo + codebase from your stack template
Step 2 — Infra scaffold  → provisions all services, fills .env.local with real keys
```

**Use independently when:**
- Code scaffold only → adding a new service module to an existing project
- Infra scaffold only → re-provisioning services, rotating keys, adding a service to an existing codebase

**The code scaffold is the blueprint** (`antigravity-workspaces/blueprint`, since 2026-07-11):
`node tools/create-app.mjs --slug <name> --name "<Name>" --domain <domain> --description "..." --github`
generates a complete, tested house-stack app (23 tests green out of the box) and creates/pushes the
GitHub repo via REST (GITHUB_TOKEN) — so run this infra script with `--skip github`.

**Invoke code scaffold:** the `new-project` skill ("new project [name] — [one sentence]")
**Invoke infra scaffold:** "Pull up the scaffold skill and spin up [name] on [domain]"
**Invoke both:** the `new-project` skill orchestrates code → infra → deploy end to end

> The `.env.example` produced by the code scaffold is the exact template for what this script writes to `.env.local` in Phase 9.

---

## Model choice when running this script
**Sonnet**, not Haiku — most steps look mechanical but require judgment from
reading API responses (reuse-vs-create when a free-tier slot is taken, the
Clerk 404 false-positive trap noted under Known Limitations below). Escalate
to Opus only for a failure this doc doesn't already document. DNS/domain/
production actions stay with the main agent regardless of model (see the
delegation rules in template CLAUDE.md).

## Quick Start

```bash
# Dry run first — always
node scaffold.js --name myapp --domain myapp.com --gh-user yourname --template yourname/saas-template

# When happy, run for real
node scaffold.js --name myapp --domain myapp.com --gh-user yourname --template yourname/saas-template --run

# Skip steps you've already done
node scaffold.js --name myapp --domain myapp.com --run --skip spaceship,github
```

---

## Automation Status at a Glance

| Service | Status | Notes |
|---|---|---|
| GitHub repo | 🟢 Automated | `gh` CLI |
| website-assets folder | 🟢 Automated | git push |
| Vercel project + domain | 🟢 Automated | REST API — `POST /v10/projects/{id}/domains` (redirect field = www→non-www built in) |
| Vercel git-link an EXISTING project | 🟢 Automated via CLI (2026-08-29) | No REST endpoint exists for this (confirmed against the live `openapi.vercel.sh` spec — `/v11/projects` POST only accepts `gitRepository` at CREATE time; there is no `/v9/projects/{id}/link`). Working recipe: `vercel link --yes --project <name> --team <teamId> -t $VERCEL_TOKEN --non-interactive` (writes `.vercel/project.json` against the pre-existing project — safe, does NOT create a duplicate), then `vercel git connect <https-repo-url> -t $VERCEL_TOKEN --non-interactive --yes`. Verified end to end on `fineally` 2026-08-29 against a project that had zero prior git link. |
| Vercel production branch | 🔴 NOT settable via API/CLI post-link (corrected 2026-08-29) | `PATCH /v9/projects/{id} {productionBranch}` is REJECTED (`should NOT have additional property`) — confirmed against the current `openapi.vercel.sh` schema, not just the 2026-08-20 lookslike-ink field report below. No CLI subcommand sets it either (`vercel project update` only covers build/dev/install commands, framework, output dir). On `fineally` the read-back **LIED**: `link.productionBranch` reported `"main"` while the very next push to `beta` produced a deployment with `target: "production"`. So re-reading the setting is NOT sufficient — **verify with a real push** (`GET /v6/deployments?projectId=…` → `target` must be `preview` for the working branch). There IS an automated fix, found 2026-08-29 and used on `fineally`: temporarily set the GitHub repo's default branch to `main` (`PATCH /repos/{o}/{r} {"default_branch":"main"}`), run `vercel git disconnect` then `vercel git connect`, then set the GitHub default back to `beta`. Vercel takes the production branch from the repo default AT CONNECT TIME, which is why this works and why reusing a pre-existing Vercel project (link added later, repo default already `beta`) gets it wrong where `vercel link` on a fresh project does not. |
| Vercel beta branch domain | 🟢 Automated (2026-07-15) | `POST /v10/projects/{id}/domains` with `gitBranch: "beta"` — CLI has no branch-scoping flag |
| Vercel function region | 🟢 Automated | `"regions": ["dub1"]` written into the repo's `vercel.json` — must match the Turso region (aws-eu-west-1); Vercel's default is iad1 (US East) |
| Turso DBs (prod + beta) | 🟢 Automated (2026-08-17) | Platform API — `GET/POST /v1/organizations/{org}/databases` (idempotent: list first, reuse a same-named DB) + `POST .../databases/{db}/auth/tokens`. Creates **two** DBs, `{name}-db` and `{name}-db-beta` (environment isolation, below). The `turso` CLI is only a fallback when `TURSO_API_TOKEN`/`TURSO_ORG` are absent — it is NOT installed on this machine |
| Upstash Redis | 🟢 Automated | `POST /v2/redis/database` — fields: `database_name`, `platform` (aws/gcp), `primary_region`, `plan`, `tls`. ⚠ Free tier = 1 DB max — if already taken, fetch existing DB via `GET /v2/redis/database/{id}` and reuse |
| Upstash QStash | 🟡 Partial | `QSTASH_TOKEN` = manual (copy from console.upstash.com/qstash, one-time). Signing keys = automated: `GET https://qstash.upstash.io/v2/keys` with Bearer token → returns `current` + `next` |
| Cloudflare R2 buckets (prod + beta) + S3 API credentials | 🟢 Automated | REST API — `POST /accounts/{id}/r2/buckets` (idempotent: `GET` first, reuse a same-named bucket), `cf-r2-jurisdiction: eu` header. Creates **two** buckets, `{name}-storage` and `{name}-storage-beta`, sharing ONE account-scoped credential pair. Access keys via `POST /accounts/{id}/tokens` (see Known Limitations) — no dashboard trip needed |
| CloudMailin account | 🔴 Always manual | No account creation API. Dashboard only: cloudmailin.com → Sign up |
| CloudMailin address target | 🟡 Partial | Address + webhook URL = dashboard only (step 2 of setup). DNS MX record → Vercel = automated. Env var `CLOUDMAILIN_WEBHOOK_SECRET` = automated. |
| Resend domain + key | 🟢 Automated | REST API |
| VAPID keypair (Web Push) | 🟢 Automated | `npx web-push generate-vapid-keys --json` — generates P-256 EC pair locally, no external service |
| OpenRouter per-project key | 🟢 Automated | Provisioning API |
| Google Cloud project + APIs | 🟢 Automated | `gcloud` CLI — enable gmail, calendar-json, people APIs |
| Google OAuth consent screen | 🔴 Always manual | IAP brand API requires Workspace org (personal accounts blocked). Cloud Console only: APIs & Services → OAuth consent screen |
| Google OAuth client ID/secret | 🔴 Always manual | Cloud Console only: Credentials → Create OAuth client ID → Web application → add redirect URIs |
| Google OAuth redirect URI update | 🔴 Always manual | Same restriction. Cloud Console: Credentials → client → Authorized redirect URIs |
| Google branding verification | 🔴 Always manual | Required for Gmail + Calendar scopes in production. Human review, 1–6 weeks. Test users bypass this. |
| Microsoft Entra app registration | 🔴 Always manual | portal.azure.com → Entra ID → App registrations. No CLI or API for initial registration in personal accounts. |
| Microsoft OAuth redirect URIs | 🔴 Always manual | Entra portal: Authentication → Add platform → Web |
| Microsoft API permissions | 🔴 Always manual | Entra portal: API permissions → Microsoft Graph → Delegated |
| Microsoft client secret | 🔴 Always manual | Entra portal: Certificates & secrets → New client secret (copy value immediately) |
| Clerk app creation | 🔴 Always manual | No public Platform API for creating apps. Dashboard only. |
| Clerk **Organizations** (enable + limits) | 🟢 Automated | `GET`/`PATCH /v1/instance/organization_settings` with Bearer sk_. `GET` returns `{enabled, max_allowed_memberships, max_allowed_roles, creator_role, admin_delete_enabled, domains_enabled, ...}`; `PATCH {"enabled":true,"max_allowed_memberships":20}` → 200. Verified live on regvoice's dev instance 2026-08-22. **Do not confuse with app creation above** - the instance must already exist; this only flips the feature ON for it. Before enabling, `/v1/organizations` 403s with `organization_not_enabled_in_instance`, which is the cheap read-only way to test the state. ⚠️ Re-READ the resource after the PATCH rather than trusting its echo - the oauth_google row below is why that habit exists. 20 members is the free (Hobby) plan's per-org ceiling; 100 orgs per app are included. 🚨 **`enabled:true` also flips `force_organization_selection` to TRUE as a side effect, even though you did not send it.** On a live instance that puts an organisation-selection wall in front of every existing user at sign-in. Send a second `PATCH {"force_organization_selection":false}` immediately and re-read. Hit on regops.systems production 2026-08-22; all three instances patched that day had it. This is the concrete reason the re-read rule above is not paranoia - the PATCH echo shows it too, but only if you look at a field you never set. |
| Clerk instance STATE without any key | 🟢 Automated | The publishable key is public (it ships in the client bundle) and is base64 of the frontend host: `pk_live_Y2xlcmsucmVnb3BzLnN5c3RlbXMk` → `clerk.regops.systems`. That host answers **unauthenticated** `GET /v1/environment?__clerk_api_version=2021-02-05&_clerk_js_version=5` with `display_config.instance_environment_type`, `application_name`, `home_url` and the whole `organization_settings` block. So you can read ANY deployed instance's config - including whether organizations are on - straight off its live site with curl, no secret, no dashboard. Scrape the pk from the site's JS bundle. Verified 2026-08-22. Complements the key-RECOVERY row below: reading state is free, writing it still needs the sk. |
| Clerk DNS records → Vercel | 🟢 Automated | `GET /v1/domains` with Bearer sk_live_ → `cname_targets[]` (`host`/`value`/`required`) = exactly what the dashboard's "Copy DNS instructions" button emits. Needs the **production** key: an `sk_test_` instance has no custom domain and returns no targets. Verified live 2026-07-15. |
| Clerk Google OAuth config | 🔴 Always manual | `PATCH /v1/instance/social_connections/oauth_google` returns 404 — endpoint does not exist. ⚠️ False-positive risk: sloppy error handling can print "success" on a 404. Dashboard only: Configure → SSO → Google → "Use custom credentials" → paste Client ID + Secret |
| Clerk keys → Vercel | 🟡 Partial (doc was aspirational — corrected 2026-07-19) | Phase 6 collects ONLY the prod instance (pk_live/sk_live) and Phase 9 pushes EVERY var to `target:["production"]` ONLY (scaffold.js ~L1039). So the dev-instance keys (pk_test/sk_test), the preview+development scopes, and the `VITE_` publishable mirror are NOT automated — set per-scope by hand via REST upsert (below). **Never `vercel env add`**: its stdin path prints `✓ Added` but stores an EMPTY value on Windows PowerShell (bit hejsmart 2026-07-19). Verify every write with `vercel env pull <f> --environment=<production\|preview\|development>`. Active CLI token: `%APPDATA%\xdg.data\com.vercel.cli\auth.json` (`.token`); the `\com.vercel.cli\Data\` copy is stale → 403. Scope map: dev `pk_test/sk_test` → preview+development, prod `pk_live/sk_live` → production, unsuffixed names (`VITE_CLERK_PUBLISHABLE_KEY`+`CLERK_PUBLISHABLE_KEY`+`CLERK_SECRET_KEY`). **TODO: make Phase 9 `_PROD`-aware (see Known Limitations).** |
| Clerk key RECOVERY (lost sk) | 🔴 Always manual | No API can return an instance secret key — the Backend API authenticates WITH it (chicken-and-egg), and `/api_keys` / machine-key secrets are one-time-at-creation only (verified 2026-07-17). Dashboard → Configure → API keys, or Chrome automation. **Prevention (scripted since 2026-07-17): `scaffold.js` auto-mirrors every pasted secret into `.scaffold-secrets` as `NAME_<PROJECT>`** (Clerk pk/sk, redirect URI, Google client id/secret) via `persistSecret()`/`askSecret()` — re-runs offer the stored copy (Enter = reuse, paste = rotate in place). Deleting the Vercel env var is never a lockout again (bit deepsonda prod on 2026-07-17). |
| Pollinations key | 🔴 Always manual | No management API yet (as of May 2026) |
| Spaceship NS change | 🟢 Automated | REST API — `PUT /v1/domains/{domain}/nameservers` |
| Spaceship DNS records | 🟢 Automated | REST API — `PUT /v1/dns/records/{domain}` |
| Spaceship email forwarding DNS | 🟢 Automated (records) | The 3 "Email Forwarding Free" records — 2× MX → `mx1`/`mx2.efwd.spaceship.net` (pref 0) + apex SPF TXT `v=spf1 include:spf.efwd.spaceship.net ~all` — are pushed to Vercel DNS by the dedicated `email-forwarding` step. The VALUES are constant across every domain; only the host varies (always the project apex). Enabling the forwards AND Spaceship's "Verify DNS changes" button have **no public API** — the whole `docs.spaceship.dev` surface is domains/DNS/nameservers/contacts only (confirmed 2026-07-19) → Chrome/dashboard only. Apex SPF assumes Resend sends from the `send.` subdomain (it does); if a project ever sends AS the bare apex, merge the two `v=spf1` includes into one record. |
| Clerk Google redirect URI | 🔴 Always manual | Not derivable — it is NOT `{frontend_api_url}/v1/oauth_callback` (that path 404s on a healthy prod instance), and no endpoint returns it. Copy from Configure → SSO → Google. |
| Vercel DNS records | 🟢 Automated | `POST /v2/domains/{domain}/records` for Resend + Clerk + Google verification. Both passes. See the DNS gotchas below. |
| Vercel www → non-www 301 | 🟢 Automated | `PATCH /v9/projects/{id}/domains/www.{domain}` `{ redirect, redirectStatusCode: 301 }` — `vercel domains add` attaches the domain but cannot set the redirect |
| Env vars → Vercel + .env.local | 🟢 Automated | REST API — `POST /v10/projects/{id}/env?upsert=true` (replaces `vercel env add` heredocs — was bash-only, broke on Windows) |
| Production deploy | 🟢 Automated | REST API — `POST /v13/deployments` with `deploymentId` to redeploy |

---

## DNS gotchas (all four verified against live Clerk + Vercel data, 2026-07-15)

Every one of these silently produces a *wrong but plausible* result, so they're
worth knowing before touching `syncDnsRecords()`.

1. **`teamId` is mandatory when the domain belongs to a team.** Without it the
   DNS endpoints answer `403 forbidden — "You don't have permission to list the
   domain record"`, which reads like a bad token and isn't. It comes from
   `orgId` in `.vercel/project.json`.
2. **Never split the host on the first dot.** Clerk returns fully-qualified
   hosts; Vercel wants them relative to the zone. `clk._domainkey.example.com`
   must become `clk._domainkey`, not `clk` — the naive split collapses both DKIM
   records to `clk`/`clk2` and quietly breaks Clerk's email deliverability.
3. **The apex is `""`, not `"@"`.** That's what Vercel's own API returns for
   apex records.
4. **Vercel stores CNAME values with a trailing dot** (`frontend-api.clerk.services.`);
   Clerk and Resend quote them without one. Compare with the dot normalized away
   or every re-run re-adds all five records as duplicates.

Resend's record shape is its own trap: `type` is the DNS type (MX/TXT/CNAME),
`record` is the *semantic* label (SPF/DKIM), `name` is already zone-relative, and
MX rows carry `priority` (→ Vercel's `mxPriority`). There is **no `record_type`
field** — reading one yields `undefined` and the records vanish silently.

---

## Full Sequence (with dependency rationale)

### PHASE 1 — Start propagation clock
```
1. Spaceship → point NS to Vercel (ns1/ns2.vercel-dns.com)  ← NOW AUTOMATED
   ⏱ Do this FIRST — propagation takes time, want it ticking in background

   API: PUT https://spaceship.dev/api/v1/domains/{domain}/nameservers
   Headers: X-API-Key: $SPACESHIP_PUBLISHABLE_KEY
            X-API-Secret: $SPACESHIP_SECRET_KEY
   Body: { "provider": "custom", "hosts": ["ns1.vercel-dns.com", "ns2.vercel-dns.com"] }
   Required scope: domains:write
   Note: field is "hosts", NOT "nameservers" — "provider" must be "custom" for external NS
```

### PHASE 0 — Code scaffold (run this first)
```
0. Run code scaffold → generates codebase, creates local repo directory
   ✅ This creates the GitHub repo that Vercel links to in Phase 2
   Invoke: "Scaffold a new [type] app called [name] with [services]"
```

### PHASE 2 — Project skeleton
```
2. GitHub → create repo from template, clone
3. GitHub (website-assets) → create /{project-name}/ folder, push
4. Vercel → create project, link repo, set framework
4b. Vercel → PATCH productionBranch=main (don't trust auto-detection)
5. Vercel → add domain + www→non-www 301 redirect
5b. Vercel → pin function region: `"regions": ["dub1"]` in vercel.json
5c. Vercel → add beta.{domain} scoped to the `beta` git branch (stable preview URL)
```

**Function region (5b) is mandatory, not cosmetic.** Vercel defaults every
project's serverless functions to `iad1` (US East) regardless of where the user
or the database lives. All our Turso DBs are in `aws-eu-west-1` (Dublin), so the
default makes EVERY DB round trip transatlantic (~90ms each — a cold-start
bootstrap with dozens of statements takes seconds; found on deepsonda
2026-07-08). Put `"regions": ["dub1"]` in the repo's `vercel.json` (survives
project re-creation; Hobby tier includes one region free). If a project's Turso
DB ever lives elsewhere, match the region to the DB, not the visitors — static
assets ship from the global CDN either way.

**productionBranch (4b) is mandatory, not defensive paranoia.** `vercel link`
auto-detects the production branch from whatever branches exist on the GitHub
remote AT LINK TIME. If `main` hasn't been pushed yet — e.g. the repo was
created manually instead of via `create-app.mjs --github` (which always pushes
`main` then `beta`) — Vercel silently picks `beta` instead, and every routine
push to `beta` becomes a PRODUCTION deploy, contradicting this workspace's
entire beta→preview→manual-promote convention (found on outrightsmart
2026-07-14: local `main` existed but was never pushed, so Vercel linked with
only `beta` on the remote and set it as production). `scaffold.js` now sets
`productionBranch: "main"` via REST right after `vercel link`, every time,
regardless of what branches exist remotely — don't remove this in favor of
trusting auto-detection again. If you hit this on an already-misconfigured
project: fast-forward local `main` to the current `beta` commit, push it, then
`PATCH https://api.vercel.com/v9/projects/{id}` with `{"productionBranch":
"main"}` (or Dashboard → Settings → Git → Production Branch).

**beta.{domain} (5c)** gives day-to-day `beta` pushes a stable, memorable
preview URL instead of a fresh `*.vercel.app` link per deployment — matches
`vercel-deploy-flow`'s beta→preview convention. Done via `POST
/v10/projects/{id}/domains` with `gitBranch: "beta"` in the body (the
dashboard equivalent: Settings → Domains → Add → set "Git Branch" to `beta`).
The `vercel domains add` CLI command has no branch-scoping flag, so this can't
be done via CLI — REST or dashboard only. No separate DNS record is needed:
the domain's NS already points at Vercel (Phase 1), so Vercel provisions
whatever the zone needs for the subdomain automatically.

### PHASE 3 — Backend services (parallel, no interdependencies)
```
6a. Turso        → create PROD + BETA DBs → TURSO_DATABASE_URL(_PROD) + TURSO_AUTH_TOKEN(_PROD)
6b. Upstash      → create Redis → UPSTASH_REDIS_URL + TOKEN
6c. Upstash      → get QStash token → QSTASH_URL + TOKEN + signing keys
6d. Cloudflare   → create PROD + BETA R2 buckets → R2_BUCKET_NAME(_PROD) + R2_ENDPOINT + ACCESS_KEY + SECRET
6e. Resend       → add domain → DNS records + RESEND_API_KEY
6f. OpenRouter   → create per-project key → OPENROUTER_API_KEY
6g. Pollinations → create per-project key (MANUAL) → POLLINATIONS_API_KEY
6h. CloudMailin  → create account (MANUAL) → create address target (MANUAL)
                   → generate CLOUDMAILIN_WEBHOOK_SECRET (automated)
                   → webhook URL: https://{domain}/api/webhook/email?secret={secret}
                   ⚠ Free tier: 10,000 msg/month. Single wildcard address *@in.{domain}.
```

### PHASE 4 — DNS first pass (with what you have so far)
```
7. Vercel DNS → Resend MX/TXT/CNAME records                      (step: dns-pass1)
              → Spaceship email-forwarding records:              (step: email-forwarding)
                  2× MX @ → mx1/mx2.efwd.spaceship.net (pref 0)
                  TXT  @ → v=spf1 include:spf.efwd.spaceship.net ~all
                  (constant values; then enable forwards + click "Verify DNS changes"
                   in Spaceship by hand — no API for those two)
              → CloudMailin MX record for in.{domain}:
                  POST /v2/domains/{domain}/records
                  { name: "in", type: "MX", value: "mx.cloudmailin.net.", mxPriority: 10 }
   ⏳ Clerk + Google records come after phases 5 & 6
```

### PHASE 5 — Google Cloud (before Clerk — Clerk needs the client ID/secret)
```
8. Google Cloud → create project (automated: gcloud projects create)
               → enable APIs (automated):
                 gcloud services enable gmail.googleapis.com \
                   calendar-json.googleapis.com people.googleapis.com \
                   --project={project-id}
               → configure OAuth consent screen (MANUAL — Cloud Console):
                 console.cloud.google.com → APIs & Services → OAuth consent screen
                 • User type: External
                 • App name, support email, logo, privacy/ToS URLs
                 • Scopes: userinfo.email, gmail.readonly, calendar.events
                 • Add test users
                 ⚠ /privacy and /terms must exist at deploy time!
               → create OAuth Web Client ID (MANUAL — Cloud Console):
                 Credentials → Create Credentials → OAuth client ID → Web application
                 • Redirect URIs: http://localhost:3000/api/auth/google/callback
                                  https://{domain}/api/auth/google/callback
               → collect: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
               → get site verification TXT → (goes to Vercel DNS in phase 7)
```

### PHASE 6 — Clerk (needs Google client from phase 5)
```
9. Clerk → create application (PARTIALLY MANUAL)
         → set production URL: https://{domain}
         → add the production domain under Configure → Domains  ← required, or
           cname_targets comes back empty
         → configure Google SSO with CLIENT_ID + CLIENT_SECRET
         → enable email+password
         → set branding (name, logo from website-assets)
         → paste when prompted: CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY
         → paste when prompted: Clerk redirect URI → (goes back to Google in phase 8)
         → DNS records: NOT copied by hand. The script calls GET /v1/domains
           with the sk_live_ key you just pasted and queues cname_targets[]
           for phase 7.
```

### PHASE 7 — DNS second pass (now you have everything) — AUTOMATED
```
10. Vercel DNS ← Clerk cname_targets[]        (fetched in phase 6, pushed here)
              ← Google site verification TXT  (pasted in phase 5, pushed here)
    Idempotent: existing records are detected and skipped, so re-running is safe.
```

### PHASE 8 — Close the Google ↔ Clerk loop + Microsoft
```
11. Google Cloud → update OAuth client: add real Clerk redirect URI
               → (optional) submit for branding verification (Gmail/Calendar scopes)

12. Microsoft Entra (MANUAL — portal.azure.com → Entra ID → App registrations):
    → New registration:
      • Name: {app name}
      • Account types: Multitenant + personal Microsoft accounts
      • Redirect URI: Web → https://{domain}/api/auth/outlook/callback
    → Authentication: add http://localhost:3000/api/auth/outlook/callback
    → Certificates & secrets → New client secret (24 months) → copy Value
    → API permissions → Microsoft Graph → Delegated:
      Mail.Read, Calendars.ReadWrite, User.Read, offline_access
    → collect: MICROSOFT_CLIENT_ID (Application ID) + MICROSOFT_CLIENT_SECRET
```

### PHASE 9 — Collect & inject all env vars
```
12. Write .env.local + push to Vercel:
    TURSO_DATABASE_URL, TURSO_AUTH_TOKEN                  ← the BETA DB
    TURSO_DATABASE_URL_PROD, TURSO_AUTH_TOKEN_PROD        ← the PRODUCTION DB
    UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN
    QSTASH_URL, QSTASH_TOKEN, QSTASH_CURRENT/NEXT_SIGNING_KEY
    R2_BUCKET_NAME (beta), R2_BUCKET_NAME_PROD, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    RESEND_API_KEY
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, NEXT_PUBLIC_VAPID_PUBLIC_KEY
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET    ← from Cloud Console OAuth client
    MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET  ← from Entra App registration
    NEXT_PUBLIC_GOOGLE_PROJECT_ID
    GEMINI_API_KEY                  ← global, from your vault
    OPENROUTER_API_KEY              ← per-project
    POLLINATIONS_API_KEY            ← per-project (manual)
    CLOUDMAILIN_WEBHOOK_SECRET      ← generated, not copied from dashboard
    CLOUDMAILIN_ADDRESS             ← copied from CloudMailin dashboard (the @cloudmailin.net address)
    NEXT_PUBLIC_APP_URL             ← https://{domain}
```

**Environment isolation — two data stores, and the `_PROD` → scope mapping.**
The full rule is `blueprint/docs/env-isolation-instruction.md`; what this script
does about it:

A preview deployment must never read or write production data. The reason is
the app's own schema bootstrap: it runs `CREATE`/`ALTER` DDL against whatever
`TURSO_DATABASE_URL` points at on the **first request of every cold start**. The
`beta` → preview → manual-promote flow gates the *code*, not the database — so
with one shared DB, pushing `beta` migrates production before anyone has looked
at the preview, and preview test rows and uploads land in live tables and
buckets. A blueprint-based app therefore **refuses to start** when the pairing is
wrong (it reads the `-beta` marker in the store name).

So Phase 3 provisions **two** of each:

| | Production | Preview + Development |
|---|---|---|
| Turso | `{name}-db` | `{name}-db-beta` |
| R2 | `{name}-storage` | `{name}-storage-beta` |

and Phase 9 maps the `_PROD` staging convention onto Vercel's env scopes —
Vercel env vars are scoped rather than name-mangled, so the app reads ONE name
everywhere and just receives different values:

| Collected key | Pushed as | Vercel scopes |
|---|---|---|
| `FOO_PROD` | `FOO` | `production` |
| `FOO` (has a `_PROD` twin) | `FOO` | `preview`, `development` |
| `FOO` (no twin) | `FOO` | `production`, `preview`, `development` |

Before 2026-08-17 every var was pushed to `production` only, which left preview
deployments with no database at all — not merely a shared one.

Deliberately NOT split, in either direction: the **central-logs DB** (append-only
observability with a `project` column — splitting it defeats the purpose and
burns a DB slot per project) and the **Upstash Redis** (free tier is one DB per
account; isolate by key prefix). Neither gets a `_PROD` twin.

### PHASE 9b — GitHub Actions secrets (repo CI, not app runtime)

Some credentials belong to a repository's CI rather than to the running app,
so they go into GitHub Actions secrets instead of Vercel env. Today that is the
reMarkable device token, used by the `remarkable-sync` module.

```
node scaffold/push-github-secrets.mjs --repo <owner>/<name> \
     --secret REMARKABLE_DEVICE_TOKEN
```

Reads `.scaffold-secrets`, fetches the repo's public key, seals each value with
libsodium `crypto_box_seal` and PUTs it. Prints names, byte counts and sha256
prefixes only — never a value. `--dry-run` resolves and seals without sending;
`--self-test` proves the sealing round-trips and exits.

- Needs `GITHUB_TOKEN` to carry repository permission **Secrets: Read and
  write**. Added to `claude-scaffold-automation` on 2026-08-22; before that it
  held only metadata + code/administration, and every `actions/*` call was 403.
- The one dependency in an otherwise dependency-free toolchain: GitHub will not
  accept a plaintext secret, and Node has no XSalsa20, so the seal cannot be
  done with `node:crypto` alone. It installs `libsodium-wrappers` into an
  OS-temp directory on first run — no package.json anywhere gains a line.
- Only push a secret to a repo that actually needs it. These are per-repo, and
  a personal account has no organisation-level secrets to fall back on.

### PHASE 10 — Launch
```
13. Vercel → trigger production deploy
14. Verify:
    ☐ DNS propagated (dig +short {domain} or dnschecker.org)
    ☐ Clerk SSO login working
    ☐ DB connection healthy
    ☐ R2 buckets accessible (prod + beta)
    ☐ Preview writes land in {name}-db-beta / {name}-storage-beta, NOT production
    ☐ Resend domain verified (check Resend dashboard)
    ☐ Google OAuth consent screen live (test login)
    ☐ www → non-www redirect working (curl -I https://www.{domain})
    ☐ CloudMailin MX propagated (dig MX in.{domain})
    ☐ CloudMailin webhook reachable (curl POST /api/webhook/email?secret=...)
```

---

## Circular Dependencies to Remember

```
Google ↔ Clerk:
  • Create Clerk app first to get redirect URI structure
  • Create Google client with placeholder redirect
  • Get Clerk's real redirect URI
  • Update Google client with real URI

Vercel DNS ← Clerk + Google:
  • Can't add Clerk DNS until Clerk app exists (Phase 6)
  • Can't add Google TXT until project + verification initiated (Phase 5)
  • Do DNS in two passes — don't wait for both before starting
```

---

## Prerequisite Setup (one-time, not per project)

### CLI tools
```bash
# Only these still required (Vercel CLI and wrangler both dropped — replaced by REST API):
brew install tursodatabase/tap/turso  # or: curl -sSfL https://get.tur.so/install.sh | bash
gh auth login
gcloud auth login
gcloud components install alpha      # for iap commands
```

### Vercel REST API (replaces Vercel CLI)
Base URL: `https://api.vercel.com`
Auth: `Authorization: Bearer $VERCEL_TOKEN`
SDK (optional, type-safe): `npm i @vercel/sdk`
OpenAPI spec: https://openapi.vercel.sh/

Key endpoints used by scaffold.js:
- Create project: `POST /v9/projects`
- Set production branch (right after `vercel link`, every time — don't trust
  auto-detection): `PATCH /v9/projects/{id}` — body: `{ "productionBranch": "main" }`
- Add domain (+ www→non-www redirect): `POST /v10/projects/{id}/domains` — body: `{ name, redirect, redirectStatusCode: 301 }`
- Add domain scoped to a git branch (e.g. `beta.{domain}` → the `beta` branch): `POST /v10/projects/{id}/domains` — body: `{ name, gitBranch: "beta" }`
- Verify domain: `POST /v9/projects/{id}/domains/{domain}/verify`
- DNS records: `POST /v2/domains/{domain}/records` — types: A, AAAA, CNAME, MX, TXT, NS, ALIAS, CAA, SRV, HTTPS
- List DNS records: `GET /v5/domains/{domain}/records`
- Delete DNS record: `DELETE /v2/domains/{domain}/records/{recordId}`
- Add/upsert env var: `POST /v10/projects/{id}/env?upsert=true`
- List env vars: `GET /v9/projects/{id}/env`
- Redeploy: `POST /v13/deployments` with `{ deploymentId: "<existing-id>", name: "<project-name>" }`

### Secrets (in `website-assets/.scaffold-secrets` — THE canonical copy, never commit it!)
> Location decided 2026-07-18: user-owned (survives Claude Code / skill
> reinstalls), gitignored + untracked in the website-assets repo, template
> beside it. The scaffold script resolves this well-known path first from any
> cwd; `~/.claude/scaffold-secrets` is a legacy fallback only — keeping a copy
> there causes rotation drift (one copy updated, the other silently stale).
> No cloud/git backup by design — the recovery path is a Bitwarden secure
> note named `scaffold-secrets`, synced with `node scaffold/secrets-sync.mjs
> push|pull|status` (whole file as the note body; needs an unlocked
> BW_SESSION; prints hashes, never values). Push after EVERY rotation.
```bash
VERCEL_TOKEN=...                             # vercel.com/account/tokens → Create Token
SPACESHIP_PUBLISHABLE_KEY=...                # spaceship.com/application/api-manager/ → API key
SPACESHIP_SECRET_KEY=...                     # spaceship.com/application/api-manager/ → API secret
                                             # Required scopes: domains:write, dnsrecords:write, dnsrecords:read
OPENROUTER_PROVISIONING_KEY=sk-or-v1-...    # create once at openrouter.ai/settings/keys → type: Provisioning
UPSTASH_MANAGEMENT_API_KEY=...               # upstash.com → Account → Management API
RESEND_API_KEY=re_...                        # your global key (script creates per-project subkeys)
CLOUDFLARE_ACCOUNT_ID=...                    # dash.cloudflare.com
CLOUDFLARE_API_TOKEN=...                     # dash.cloudflare.com/profile/api-tokens
GEMINI_API_KEY=AIza...                       # aistudio.google.com (global)
```

### Make sure .scaffold-secrets is gitignored
```bash
echo ".scaffold-secrets" >> ~/.gitignore_global
# or per-repo:
echo ".scaffold-secrets" >> .gitignore
```

---

## Known Limitations / Things to Watch

- **Spaceship**: Full REST API available at `https://spaceship.dev/api/v1`. Auth via `X-API-Key` + `X-API-Secret` headers. Key management at `spaceship.com/application/api-manager/`. NS changes need `domains:write` scope; DNS record CRUD needs `dnsrecords:write`/`dnsrecords:read`. Both are fully automatable.
- **Microsoft Entra app registration**: Fully manual. portal.azure.com → Entra ID → App registrations → New registration. No CLI or API path for personal Microsoft accounts. Required fields: name, account type (multitenant + personal), redirect URIs. Client secret must be copied immediately after creation (only shown once). Permissions: `Mail.Read`, `Calendars.ReadWrite`, `User.Read`, `offline_access` — all Delegated (not Application). Secret expiry: max 24 months; add a calendar reminder to rotate before expiry.
- **Google OAuth consent screen + client**: Fully manual for personal Google accounts. IAP brand API (`iap.googleapis.com/v1/projects/{id}/brands`) requires a Google Workspace org — personal projects get `"Project must belong to an organization"`. `gcloud alpha` components need admin rights to install. `clientauthconfig.googleapis.com` returns 404. No working programmatic path exists for personal accounts. Use Cloud Console: console.cloud.google.com → APIs & Services → OAuth consent screen, then Credentials → Create OAuth client ID.
- **Clerk social login config**: `PATCH /v1/instance/social_connections/oauth_google` does NOT exist — returns 404. The Clerk Backend API has no endpoint for configuring social providers. **Do not attempt to automate this — you will get a 404 which can produce a false positive if error handling is sloppy.** Must be done in the dashboard: Configure → SSO → Google → toggle "Use custom credentials" → paste Client ID + Secret. There is no way to confirm success programmatically; verify in the dashboard UI after saving.
- **Pollinations key management API**: Feature requested Jan 2026, not shipped yet. Check: [github.com/pollinations/pollinations/issues/6766](https://github.com/pollinations/pollinations/issues/6766)
- **Upstash Redis**: `POST /v2/redis/database` works — correct fields are `database_name` (not `name`), `platform` (aws/gcp, required), `primary_region`. Free tier = 1 DB max. If the slot is taken, fetch the existing DB via `GET /v2/redis/database/{id}` — `rest_token` and `endpoint` are returned directly, no manual copy needed. Auth: Basic `email:api_key`.
- **Upstash QStash token**: `QSTASH_TOKEN` must be copied manually from console.upstash.com/qstash (no Management API endpoint). Once you have it, signing keys are automated: `GET https://qstash.upstash.io/v2/keys` with `Authorization: Bearer $QSTASH_TOKEN`.
- **Vercel CLI**: Dropped from scaffold.js — replaced by REST API (`https://api.vercel.com`). Was bash-only due to heredoc `<<< "value"` in `vercel env add`. REST API is cross-platform and needs only `VERCEL_TOKEN`.
- **Vercel production branch auto-detection**: `vercel link` picks the production branch from whichever branches exist on the GitHub remote at that moment — it is NOT guaranteed to be `main`. If the repo was created outside `create-app.mjs`'s automated `--github` path (which always pushes `main` then `beta`) and only `beta` got pushed, Vercel sets `beta` as production, and every routine push to `beta` becomes a live production deploy. Fixed 2026-07-15: scaffold.js now `PATCH`es `productionBranch: "main"` right after every `vercel link`, unconditionally. If you're auditing an existing project, verify via `GET /v9/projects/{id}` (field `link.productionBranch` or top-level `productionBranch`, depending on API version) rather than assuming it's correct.
- **CloudMailin**: Account creation and address target configuration are dashboard-only (cloudmailin.com — no account creation API). Free tier assigns one **shared `@cloudmailin.net` address** per account — custom domains (`*@in.{domain}`) require a paid plan. Two routing strategies: (A) free tier — route by `X-Forwarded-To` header (user's email injected by Gmail/Outlook/Apple Mail when forwarding); (B) paid — per-household token in `To:` address. The shared secret is *generated by you* (not given by CloudMailin) — generate it, push to Vercel, paste into the CloudMailin webhook URL. MX target for custom domain: `mx.cloudmailin.net.` (priority 10). Add `CLOUDMAILIN_ADDRESS` env var for the assigned `@cloudmailin.net` address shown in dashboard.
- **Cloudflare R2 access keys**: R2 S3-compatible credentials (Access Key ID + Secret) are created via `POST /accounts/{id}/tokens` — NOT `/r2/tokens` (no such route) and NOT `/user/tokens`. Use account-scope (`com.cloudflare.api.account.{id}`) for all four R2 permissions (Storage Read, Storage Write, Bucket Item Read, Bucket Item Write). `R2_ACCESS_KEY_ID` = response `id`; `R2_SECRET_ACCESS_KEY` = SHA-256 hex of response `value`. The `CLOUDFLARE_API_TOKEN` in `.scaffold-secrets` must have "Account API Tokens: Edit" permission to create tokens via API. **Implemented in `scaffold.js`'s `r2` step (2026-07-30)** — this entry stays as the reference for *why* the derivation looks the way it does; it is no longer a manual dashboard step. The bucket itself also went through the REST API (`POST /accounts/{id}/r2/buckets`, idempotent via a `GET` first) rather than `wrangler`, under `cf-r2-jurisdiction: eu`, with `R2_ENDPOINT` using the `.eu.` infix required for jurisdiction-eu buckets.

---

## Learnings from the lookslike-ink run (2026-08-20) — fold into the script when touched next

1. **The FIRST git deployment of the GitHub default branch goes to PRODUCTION even
   when `link.productionBranch` reads back `"main"`.** Verified live: project created
   via REST with `gitRepository`, read-back said `main`, the first `beta` push built
   with `target: production` and aliased the apex + www. The read-back is NOT the
   guard the playbook thought it was — Vercel appears to special-case the initial
   deployment of the repo's default branch. The SECOND beta push correctly built as
   preview (`target: null`). Consequence: for a repo whose default branch is `beta`
   (our convention), expect the first beta push to hit production — harmless on a
   brand-new project (empty prod DB gets the right schema), but do it consciously,
   BEFORE real data exists, never as a routine push later.
2. **`PATCH /v9/projects/{id} {productionBranch}` is GONE** — the API now rejects it
   as an unknown property (scaffold.js's Phase 2 PATCH currently fails silently into
   its manual-fallback path). `link.productionBranch` was already `main` on creation
   in this run, so nothing needed setting — but the script's read-back check is now
   the only working part of that block. Fix the script when touched next.
3. **`POST /v5/domains` (raw REST account-domain add) creates a BROKEN domain entry:**
   `Intended Nameservers: -`, the zone never provisions, every record write 400s with
   "not a DNS zone", and ns1/ns2.vercel-dns.com answer REFUSED for the domain (lame
   delegation; public resolvers SERVFAIL). The fix that worked: delete the project +
   account domain entries, then `vercel domains add <domain> <project>` (CLI) — that
   path assigns the intended-NS set and provisions the zone immediately.
4. **scaffold.js cannot run headless**: `step("pollinations", …)` is a bare statement
   (not `if`-gated), so its `waitForEnter` fires even when the step is skipped and
   kills a stdin-less run before Phase 4/9 — and every API-collected secret lives
   only in memory, so the run's Turso/R2/Resend/OpenRouter tokens are lost with it.
   Ran the tail phases by hand this time. When touched next: gate the pollinations
   block, and persist collected values incrementally (the `persistSecret` machinery
   already exists for pasted ones).
5. **Resend re-runs**: `POST /domains` on an existing domain 403s ("registered
   already") and the step gives up instead of reusing — GET /domains, match by name,
   fetch records from the detail endpoint, mint the key against the found id.
6. **R2_PUBLIC_DOMAIN can be automated** when a project WANTS public objects (e.g.
   lookslike-ink's gallery images): `PUT /accounts/{id}/r2/buckets/{bucket}/domains/managed
   {enabled:true}` (with `cf-r2-jurisdiction: eu`) returns the `pub-*.r2.dev` domain.
   The "left blank on purpose" default stays right for user-owned files.

## Learnings from the hejsmart run (2026-07-17) — fold into the script when touched next

- **`vercel link` cannot run non-interactively.** REST alternative that works end to end:
  `POST /v9/projects` with `{ name, framework, gitRepository: { type: 'github', repo } }`, then
  write `.vercel/project.json` yourself (`{ projectId, orgId: accountId }`).
- **`PATCH /v9/projects/{id} { productionBranch }` now 400s** ("should NOT have additional
  property"). The setting read back as `link.productionBranch: "main"` anyway — BUT the FIRST
  deployment of a brand-new project goes to **production regardless of branch** (a beta push
  produced `target: production`). Subsequent pushes respect the branch. Don't panic-patch; do
  make the first push the one you want serving production.
- **Vercel zone creation for an API-added external domain is ASYNC and slow - hours, not
  minutes.** Symptoms while pending: `zone: false`, `ns1.vercel-dns.com` answers REFUSED (lame
  delegation, SERVFAIL everywhere), records API says `invalid_zone` - even AFTER `nsVerifiedAt`
  is set. Detach/re-add and the verify endpoint don't visibly accelerate it. RESOLUTION
  (hejsmart, 2026-07-17): the zone materialized on its own ~2h after the domain re-add, with no
  Vercel-dashboard action - so the fix is patience, not surgery. **Don't flip-flop nameservers
  in that window** (each flip adds propagation churn). Verify readiness by querying
  `ns1.vercel-dns.com` directly, not through a resolver. A valid stopgap while waiting: host the
  zone at Spaceship (`PUT /v1/domains/{d}/nameservers { provider: "basic" }`) with Vercel's
  `recommendedIPv4[0]` + `recommendedCNAME[0]` from `GET /v6/domains/{d}/config` - Spaceship
  records API: `PUT /v1/dns/records/{d}` `{ force: true, items: [{ type: 'A', name: '@',
  address, ttl }, { type: 'CNAME', name, cname, ttl }] }` - Vercel serves via `configuredBy: "A"`
  either way and transitions transparently when the NS move to Vercel later.
- **`beta.<domain>` 404s until the SECOND beta push.** Because the first deployment of a fresh
  project targets production (above), no *preview* deployment exists yet for the branch-scoped
  domain; an empty-commit push to `beta` creates one and the 404 resolves.
- **`teamId` gotcha confirmed again**: every `/v5/domains*` call 403s without `?teamId=<orgId>`.
- **`UPSTASH_MANAGEMENT_API_KEY` returns 401 with Bearer auth** — key rotated or the API wants
  `Basic email:key`. Shared-Redis reuse from a sibling project's `.env` is the workaround (the
  house ratelimit module namespaces keys per project).
- **Resend free plan = 1 domain** — adding a second domain 403s ("Your plan includes 1 domain").
- **Script cwd assumptions are inconsistent**: `vercel`/`turso` steps use `{ cwd: PROJECT_NAME }`
  (expects the workspaces root) but the assets step uses `../website-assets` (expects a project
  dir). Run from the workspaces root and expect the assets step to fail. The Turso env-var
  drift (`DATABASE_URL` vs the template's `TURSO_DATABASE_URL`) was fixed 2026-08-17;
  `UPSTASH_REDIS_URL` vs `UPSTASH_REDIS_REST_URL` is still drifted.

## Learnings from the fineally run (2026-08-29) — fold into the script when touched next

1. **Linking git to a Vercel project that already exists (created out-of-band,
   e.g. by hand for a domain that was already live) has no REST path.**
   Checked the live `openapi.vercel.sh` spec directly rather than trusting
   memory: `POST /v11/projects` (project creation moved off `/v9` at some
   point) accepts `gitRepository: { type, repo }` but ONLY at creation; the
   `PATCH /v9/projects/{idOrName}` schema has no `gitRepository`, no `link`,
   and no `productionBranch` property at all — sending any of them 400s as an
   unknown property. There is no `/v9/projects/{id}/link` endpoint either
   (searched every path containing "link", "git", or "connect" in the spec).
   The working path is two CLI calls, fully non-interactive:
   ```
   vercel link --yes --project <name> --team <teamId> -t $VERCEL_TOKEN --non-interactive
   vercel git connect <https-repo-url> -t $VERCEL_TOKEN --non-interactive --yes
   ```
   The first writes `.vercel/project.json` against the EXISTING project (by
   name — confirmed it does not create a second project); the second reads
   that file and performs the link. Needs the Vercel CLI installed
   (`npm i -g vercel`) — REST alone cannot do this today.
2. **`productionBranch` cannot be set explicitly at all post-link, by any
   documented path.** It is decided by Vercel at the moment `git connect`
   runs and is read-only afterward (confirmed against the spec, not just
   inferred from a 400). On fineally it came back `"main"` even though the
   repo's own configured default branch is `beta` — so it is NOT simply
   "whatever branch GitHub calls default" either; treat it as opaque and
   **always verify with `GET /v9/projects/{id}?teamId=...` → `link.productionBranch`
   after connecting**, don't assume either way. If it lands wrong, the only
   fix today is Dashboard → Settings → Git → Production Branch — there is no
   API or CLI escape hatch, which makes this the same "manual, no exceptions"
   category as the Clerk Google SSO row above.
3. **Upstash `UPSTASH_MANAGEMENT_API_KEY` with `Authorization: Bearer` on
   `GET /v2/redis/database` still fails** — this time with `token contains an
   invalid number of segments` (the endpoint expects a JWT-shaped bearer
   token; the stored key isn't one). This reconfirms the 2026-07-17 hejsmart
   finding below rather than being a new break. The reuse workaround is
   simpler than re-deriving Basic auth: every sibling project's `.env` already
   carries the one shared Redis's `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN` — grep any of them (they're all identical,
   confirmed across 8 projects on this account) and reuse directly, verified
   live with a `GET {url}/ping` → `PONG`. Fixing the management-key auth is
   still open; this is the pragmatic bypass, not a fix.

## Changelog

| Date | Change |
|---|---|
| 2026-05 | Initial version — all services mapped, dry-run script built |
| 2026-05 | Added Phase 0 (code scaffold), two-skill system docs, aligned env var names (DATABASE_URL → TURSO_DATABASE_URL) |
| 2026-05 | Spaceship upgraded 🔴→🟢: confirmed REST API at spaceship.dev/api/v1 — NS change + DNS records both automated; added SPACESHIP_PUBLISHABLE_KEY + SPACESHIP_SECRET_KEY to secrets |
| 2026-05 | Vercel CLI dropped from scaffold.js — replaced by REST API (api.vercel.com). Fixes Windows incompatibility (heredoc `vercel env add`). Add VERCEL_TOKEN to .scaffold-secrets. SDK available: `npm i @vercel/sdk` |
| 2026-05 | Added Microsoft Entra (Outlook OAuth) and expanded Google OAuth docs. Both fully manual. Gmail + Calendar APIs now automated via gcloud. Phase 8 extended with Microsoft step. |
| 2026-05 | Added CloudMailin for inbound email (F04 pattern). Account + address = manual; MX record + env var = automated. Secret is generated (not given by CloudMailin). MX target: `mx.cloudmailin.net.` priority 10. Free tier: 10k msg/month. |
| 2026-05 | Added VAPID keypair generation step (Web Push, F15). Uses `npx web-push generate-vapid-keys --json` — no external service, just local key gen. Produces `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. |
| 2026-05 | Phase 9 env push fully replaced with Vercel REST API (`POST /v10/projects/{id}/env?upsert=true`). Cross-platform (no bash heredoc). Reads project ID from `.vercel/project.json`. Requires `VERCEL_TOKEN` in `.scaffold-secrets`. |
| 2026-07 | Phase 0 code scaffold now exists: the blueprint monorepo (`antigravity-workspaces/blueprint`) + `new-project` skill. `create-app.mjs` generates the repo AND creates/pushes GitHub via REST — run scaffold.js with `--skip github`. |
| 2026-08-17 | **Environment isolation.** Turso and R2 now provision TWO stores each (`{name}-db` + `{name}-db-beta`, `{name}-storage` + `{name}-storage-beta`), and Phase 9 maps `_PROD` → Production scope / its twin → Preview+Development instead of pushing everything to Production only. Turso moved off the (uninstalled) CLI onto the Platform API, idempotent like the R2 step, and its collected var names were corrected to the template's `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`. Rule: `blueprint/docs/env-isolation-instruction.md`. |
| 2026-08-29 | **Vercel git-link on a pre-existing project has no REST path** (confirmed against the live openapi spec) — `vercel link --yes --project <name> --team <teamId> --non-interactive` then `vercel git connect <url> --non-interactive --yes` is the verified working recipe. `productionBranch` is confirmed read-only post-link by any means (API or CLI) — verify with a GET after connecting, don't assume. Upstash management-key `GET /v2/redis/database` still broken; reuse a sibling project's `.env` Redis creds instead (all identical across the account). |

---

*Update this file when something changes. Future-you will be grateful.*
