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

**Invoke code scaffold:** "Scaffold a new [Vite+Express / Next.js / mobile] app called [name]"
**Invoke infra scaffold:** "Pull up the scaffold skill and spin up [name] on [domain]"
**Invoke both:** "Full project scaffold for [name] — [one sentence description]"

> The `.env.example` produced by the code scaffold is the exact template for what this script writes to `.env.local` in Phase 9.

---

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
| Turso DB | 🟢 Automated | `turso` CLI |
| Upstash Redis | 🔴 Manual | API changed — `/v2/redis/database` POST deprecated, no replacement found (May 2026). Create via console.upstash.com |
| Upstash QStash | 🔴 Manual | Token only retrievable from console.upstash.com/qstash — no management API endpoint |
| Cloudflare R2 bucket | 🟢 Automated | `wrangler` CLI |
| Resend domain + key | 🟢 Automated | REST API |
| OpenRouter per-project key | 🟢 Automated | Provisioning API |
| Google Cloud project + APIs | 🟢 Automated | `gcloud` CLI |
| Google OAuth client | 🟡 Partial | Consent screen = manual; gcloud alpha path is deprecated |
| Google branding verification | 🔴 Always manual | Human review, weeks |
| Clerk app creation | 🟡 Partial | Platform API exists; social login + branding = dashboard |
| Pollinations key | 🔴 Always manual | No management API yet (as of May 2026) |
| Spaceship NS change | 🟢 Automated | REST API — `PUT /v1/domains/{domain}/nameservers` |
| Spaceship DNS records | 🟢 Automated | REST API — `PUT /v1/dns/records/{domain}` |
| Vercel DNS records | 🟡 Mixed | Automated for Resend; manual for Clerk/Google (2nd pass) |
| Env vars → Vercel + .env.local | 🟢 Automated | REST API — `POST /v10/projects/{id}/env?upsert=true` (replaces `vercel env add` heredocs — was bash-only, broke on Windows) |
| Production deploy | 🟢 Automated | REST API — `POST /v13/deployments` with `deploymentId` to redeploy |

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
5. Vercel → add domain + www→non-www 301 redirect
```

### PHASE 3 — Backend services (parallel, no interdependencies)
```
6a. Turso        → create DB → DB_URL + DB_AUTH_TOKEN
6b. Upstash      → create Redis → UPSTASH_REDIS_URL + TOKEN
6c. Upstash      → get QStash token → QSTASH_URL + TOKEN + signing keys
6d. Cloudflare   → create R2 bucket → R2_ENDPOINT + ACCESS_KEY + SECRET
6e. Resend       → add domain → DNS records + RESEND_API_KEY
6f. OpenRouter   → create per-project key → OPENROUTER_API_KEY
6g. Pollinations → create per-project key (MANUAL) → POLLINATIONS_API_KEY
```

### PHASE 4 — DNS first pass (with what you have so far)
```
7. Vercel DNS → Resend MX/TXT/CNAME records
              → Email forwarding records
   ⏳ Clerk + Google records come after phases 5 & 6
```

### PHASE 5 — Google Cloud (before Clerk — Clerk needs the client ID/secret)
```
8. Google Cloud → create project
               → enable APIs
               → configure OAuth consent screen (PARTIALLY MANUAL)
                 • app name, logo, privacy policy URL, ToS URL
                 ⚠ /privacy must exist in your template at deploy time!
               → create OAuth Web Client ID → CLIENT_ID + CLIENT_SECRET
               → get site verification TXT → (goes to Vercel DNS in phase 7)
```

### PHASE 6 — Clerk (needs Google client from phase 5)
```
9. Clerk → create application (PARTIALLY MANUAL)
         → set production URL: https://{domain}
         → configure Google SSO with CLIENT_ID + CLIENT_SECRET
         → enable email+password
         → set branding (name, logo from website-assets)
         → production environment setup
         → collect: CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY
         → collect: Clerk DNS records → (goes to Vercel DNS in phase 7)
         → collect: Clerk redirect URI → (goes back to Google in phase 8)
```

### PHASE 7 — DNS second pass (now you have everything)
```
10. Vercel DNS → Clerk DNS records (CNAME, TXT)
              → Google site verification TXT
```

### PHASE 8 — Close the Google ↔ Clerk loop
```
11. Google Cloud → update OAuth client: add real Clerk redirect URI
               → (optional) submit for branding verification
```

### PHASE 9 — Collect & inject all env vars
```
12. Write .env.local + push to Vercel:
    TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
    UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN
    QSTASH_URL, QSTASH_TOKEN, QSTASH_CURRENT/NEXT_SIGNING_KEY
    R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    RESEND_API_KEY
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
    NEXT_PUBLIC_GOOGLE_PROJECT_ID
    GEMINI_API_KEY                  ← global, from your vault
    OPENROUTER_API_KEY              ← per-project
    POLLINATIONS_API_KEY            ← per-project (manual)
```

### PHASE 10 — Launch
```
13. Vercel → trigger production deploy
14. Verify:
    ☐ DNS propagated (dig +short {domain} or dnschecker.org)
    ☐ Clerk SSO login working
    ☐ DB connection healthy
    ☐ R2 bucket accessible
    ☐ Resend domain verified (check Resend dashboard)
    ☐ Google OAuth consent screen live (test login)
    ☐ www → non-www redirect working (curl -I https://www.{domain})
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
# Only these still required (Vercel CLI dropped — replaced by REST API):
brew install tursodatabase/tap/turso  # or: curl -sSfL https://get.tur.so/install.sh | bash
npm install -g wrangler
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
- Add domain (+ www→non-www redirect): `POST /v10/projects/{id}/domains` — body: `{ name, redirect, redirectStatusCode: 301 }`
- Verify domain: `POST /v9/projects/{id}/domains/{domain}/verify`
- DNS records: `POST /v2/domains/{domain}/records` — types: A, AAAA, CNAME, MX, TXT, NS, ALIAS, CAA, SRV, HTTPS
- List DNS records: `GET /v5/domains/{domain}/records`
- Delete DNS record: `DELETE /v2/domains/{domain}/records/{recordId}`
- Add/upsert env var: `POST /v10/projects/{id}/env?upsert=true`
- List env vars: `GET /v9/projects/{id}/env`
- Redeploy: `POST /v13/deployments` with `{ deploymentId: "<existing-id>", name: "<project-name>" }`

### Secrets (in .scaffold-secrets — never commit this file!)
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
- **Google OAuth consent screen**: `gcloud alpha iap oauth-*` works but is deprecated (IAP API shutdown pending). Watch for gcloud dropping these commands.
- **Clerk social login config**: The Platform API (`dashboard.clerk.com`) covers app creation, but wiring Google CLIENT_ID/SECRET still goes through the dashboard as of May 2026.
- **Pollinations key management API**: Feature requested Jan 2026, not shipped yet. Check: [github.com/pollinations/pollinations/issues/6766](https://github.com/pollinations/pollinations/issues/6766)
- **Upstash Redis creation API**: `POST /v2/redis/database` is deprecated (returns "regional db creation is deprecated") and no v3/global replacement was found as of May 2026. Create manually at console.upstash.com, then grab `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` from the database detail page.
- **Upstash QStash token**: Not retrievable via Management API. Copy `QSTASH_TOKEN` + signing keys from console.upstash.com/qstash.
- **Vercel CLI**: Dropped from scaffold.js — replaced by REST API (`https://api.vercel.com`). Was bash-only due to heredoc `<<< "value"` in `vercel env add`. REST API is cross-platform and needs only `VERCEL_TOKEN`.

---

## Changelog

| Date | Change |
|---|---|
| 2026-05 | Initial version — all services mapped, dry-run script built |
| 2026-05 | Added Phase 0 (code scaffold), two-skill system docs, aligned env var names (DATABASE_URL → TURSO_DATABASE_URL) |
| 2026-05 | Spaceship upgraded 🔴→🟢: confirmed REST API at spaceship.dev/api/v1 — NS change + DNS records both automated; added SPACESHIP_PUBLISHABLE_KEY + SPACESHIP_SECRET_KEY to secrets |
| 2026-05 | Vercel CLI dropped from scaffold.js — replaced by REST API (api.vercel.com). Fixes Windows incompatibility (heredoc `vercel env add`). Add VERCEL_TOKEN to .scaffold-secrets. SDK available: `npm i @vercel/sdk` |

---

*Update this file when something changes. Future-you will be grateful.*
