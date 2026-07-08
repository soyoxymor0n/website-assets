#!/usr/bin/env node
/**
 * scaffold.js — Project scaffolding automation
 * 
 * Usage:
 *   node scaffold.js --name "myapp" --domain "myapp.com"   # dry run (default)
 *   node scaffold.js --name "myapp" --domain "myapp.com" --run
 *   node scaffold.js --name "myapp" --domain "myapp.com" --run --skip github,turso
 *
 * Prerequisites (install once):
 *   npm install -g vercel
 *   npm install -g @turso/cli   (or: brew install tursodatabase/tap/turso)
 *   npm install -g wrangler
 *   gh auth login
 *   gcloud auth login
 *
 * Secrets needed in your environment (or .scaffold-secrets file):
 *   OPENROUTER_PROVISIONING_KEY   — from openrouter.ai/settings/keys (create one "Provisioning" key)
 *   UPSTASH_MANAGEMENT_API_KEY    — from upstash.com/account
 *   RESEND_API_KEY                — from resend.com/api-keys (your global key)
 *   CLOUDFLARE_ACCOUNT_ID         — from dash.cloudflare.com
 *   CLOUDFLARE_API_TOKEN          — from dash.cloudflare.com/profile/api-tokens
 *   GITHUB_TOKEN                  — or just use `gh auth login`
 *   GEMINI_API_KEY                — your global key from aistudio.google.com
 */

import { execSync, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import readline from "readline";

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const has = (flag) => args.includes(flag);

const PROJECT_NAME = get("--name");
const PROJECT_DOMAIN = get("--domain");
const DRY_RUN = !has("--run");
const SKIP_STEPS = (get("--skip") || "").split(",").filter(Boolean);
const TEMPLATE_REPO = get("--template") || ""; // optional: "yourghuser/template-repo"
const ASSETS_REPO = get("--assets-repo") || "website-assets"; // your public assets repo name
const GH_USER = get("--gh-user") || ""; // your GitHub username

if (!PROJECT_NAME || !PROJECT_DOMAIN) {
  console.error(`
Usage: node scaffold.js --name <name> --domain <domain> [options]

Required:
  --name      Short project slug, e.g. "myapp"
  --domain    Production domain, e.g. "myapp.com"

Optional:
  --run              Actually execute (default: dry run)
  --skip a,b,c       Comma-separated step IDs to skip
  --template repo    GitHub template repo to clone (owner/repo)
  --assets-repo      Name of your website-assets repo (default: website-assets)
  --gh-user          Your GitHub username

Step IDs you can skip:
  spaceship, github, assets, vercel, turso, upstash-redis, upstash-qstash,
  r2, resend, openrouter, vapid, google, clerk, dns-pass1, dns-pass2, env, deploy

Example:
  node scaffold.js --name myapp --domain myapp.com --gh-user patrickXYZ \\
    --template patrickXYZ/saas-template --run --skip spaceship
`);
  process.exit(1);
}

// ─── Secrets / env ───────────────────────────────────────────────────────────

// Resolve secrets independent of cwd so this works when run as a global skill.
// Order: machine-global (~/.claude/scaffold-secrets) → script-relative
// (../.scaffold-secrets, the website-assets checkout) → cwd (./.scaffold-secrets).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SECRETS_CANDIDATES = [
  join(homedir(), ".claude", "scaffold-secrets"),
  resolve(SCRIPT_DIR, "..", ".scaffold-secrets"),
  resolve(process.cwd(), ".scaffold-secrets"),
];
const SECRETS_FILE = SECRETS_CANDIDATES.find((p) => existsSync(p));
if (SECRETS_FILE) {
  const lines = readFileSync(SECRETS_FILE, "utf8").split("\n");
  for (const line of lines) {
    const [k, ...rest] = line.split("=");
    if (k && rest.length) process.env[k.trim()] = rest.join("=").trim();
  }
}

const env = (key) => process.env[key] || "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const GREY   = "\x1b[90m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

const c = (color, str) => `${color}${str}${RESET}`;

let stepCount = 0;
const results = []; // { id, label, status, notes }

function header(phase, title) {
  console.log(`\n${c(BOLD, c(CYAN, `▶ PHASE ${phase}: ${title}`))}`);
  console.log(c(GREY, "─".repeat(60)));
}

function step(id, label) {
  if (SKIP_STEPS.includes(id)) {
    console.log(c(GREY, `  [SKIP] ${label}`));
    results.push({ id, label, status: "skipped", notes: "" });
    return false;
  }
  stepCount++;
  console.log(`\n${c(BOLD, `  STEP ${stepCount}: ${label}`)}`);
  return true;
}

function cmd(command, { cwd, note } = {}) {
  if (DRY_RUN) {
    console.log(c(GREY, `    $ ${command}`));
    if (note) console.log(c(YELLOW, `    ↳ ${note}`));
    return "[DRY RUN]";
  }
  try {
    console.log(c(GREY, `    $ ${command}`));
    const out = execSync(command, {
      cwd,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    }).toString().trim();
    if (out) console.log(c(GREY, `    ${out}`));
    return out;
  } catch (e) {
    const msg = e.stderr?.toString() || e.message;
    console.error(c(RED, `    ✗ FAILED: ${msg}`));
    throw e;
  }
}

async function httpPost(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

function manual(description, details = []) {
  console.log(c(YELLOW, `    ⚠ MANUAL STEP:`));
  console.log(c(YELLOW, `      ${description}`));
  for (const d of details) console.log(c(YELLOW, `      • ${d}`));
}

function info(msg) {
  console.log(c(GREEN, `    ✓ ${msg}`));
}

function note(msg) {
  console.log(c(GREY, `    ℹ ${msg}`));
}

async function waitForEnter(prompt = "Press Enter when done...") {
  if (DRY_RUN) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(c(YELLOW, `\n    ⏸  ${prompt} `), () => { rl.close(); resolve(); }));
}

// Collected secrets to write out at the end
const collected = {};
function collect(key, value) {
  collected[key] = value;
  if (value && value !== "[DRY RUN]") info(`Collected ${key}`);
  else note(`Will collect: ${key}`);
}

// ─── PHASE 1: Domain delegation ──────────────────────────────────────────────

header(1, "Domain delegation (start the propagation clock)");

if (step("spaceship", "Spaceship → point NS to Vercel")) {
  manual(
    `Log in to Spaceship and update NS records for ${PROJECT_DOMAIN}`,
    [
      "Go to: spaceship.com → Domains → " + PROJECT_DOMAIN + " → Nameservers",
      "Set to Vercel's nameservers: ns1.vercel-dns.com, ns2.vercel-dns.com",
      "Save — propagation starts now, will be done by the time you reach DNS steps",
    ]
  );
  await waitForEnter(`Done updating Spaceship NS for ${PROJECT_DOMAIN}?`);
  results.push({ id: "spaceship", label: "Spaceship NS", status: "manual-done", notes: "Propagation in progress" });
}

// ─── PHASE 2: Repos & project shell ──────────────────────────────────────────

header(2, "Repos & project shell");

if (step("github", "GitHub → create project repo")) {
  if (TEMPLATE_REPO) {
    cmd(`gh repo create ${PROJECT_NAME} --private --template ${TEMPLATE_REPO} --clone`);
  } else {
    cmd(`gh repo create ${PROJECT_NAME} --private --clone`);
    note("No --template specified. Repo created empty.");
  }
  results.push({ id: "github", label: "GitHub repo", status: DRY_RUN ? "dry" : "done", notes: "" });
}

if (step("assets", `GitHub → create assets folder in ${ASSETS_REPO}`)) {
  const assetsDir = `../${ASSETS_REPO}/${PROJECT_NAME}`;
  note(`Target path: ${assetsDir}`);
  if (!DRY_RUN) {
    if (!existsSync(`../${ASSETS_REPO}`)) {
      console.error(c(RED, `    ✗ ${ASSETS_REPO} repo not found at ../. Make sure it's cloned locally.`));
    } else {
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(`${assetsDir}/.gitkeep`, "");
      cmd(`git -C ../${ASSETS_REPO} add ${PROJECT_NAME}/`);
      cmd(`git -C ../${ASSETS_REPO} commit -m "feat: add ${PROJECT_NAME} assets folder"`);
      cmd(`git -C ../${ASSETS_REPO} push`);
      info(`Assets folder created: ${assetsDir}`);
    }
  } else {
    note(`Would create: ${assetsDir}/.gitkeep and push to ${ASSETS_REPO}`);
  }
  results.push({ id: "assets", label: "Assets folder", status: DRY_RUN ? "dry" : "done", notes: `website-assets/${PROJECT_NAME}/` });
}

if (step("vercel", "Vercel → create project & link repo")) {
  note("This will prompt interactively — choose the GitHub repo you just created");
  note(`Framework detection: pick your stack (Next.js, etc.)`);
  note(`Root directory: . (or wherever your app lives)`);
  if (!DRY_RUN) {
    cmd(`vercel link`, { cwd: PROJECT_NAME });
    cmd(`vercel domains add ${PROJECT_DOMAIN}`, { cwd: PROJECT_NAME });
    // www → non-www redirect
    cmd(`vercel domains add www.${PROJECT_DOMAIN}`, { cwd: PROJECT_NAME });
    // Pin the function region to the Turso region (aws-eu-west-1 → dub1).
    // Vercel defaults to iad1 (US East), which puts every DB round trip
    // across the Atlantic (~90ms each — seconds per cold-start bootstrap).
    const vercelJsonPath = join(PROJECT_NAME, "vercel.json");
    const vercelCfg = existsSync(vercelJsonPath)
      ? JSON.parse(readFileSync(vercelJsonPath, "utf8"))
      : {};
    if (!vercelCfg.regions) {
      writeFileSync(
        vercelJsonPath,
        JSON.stringify({ regions: ["dub1"], ...vercelCfg }, null, 2) + "\n"
      );
      info(`Pinned function region to dub1 in ${vercelJsonPath} (matches Turso aws-eu-west-1)`);
    }
    manual(
      "Set up www → non-www 301 redirect in Vercel dashboard",
      [
        `Dashboard → ${PROJECT_NAME} → Settings → Domains`,
        `Set www.${PROJECT_DOMAIN} to redirect (301) to ${PROJECT_DOMAIN}`,
      ]
    );
  } else {
    cmd(`vercel link`, { note: "Interactive prompt — links repo to Vercel project" });
    cmd(`vercel domains add ${PROJECT_DOMAIN}`);
    cmd(`vercel domains add www.${PROJECT_DOMAIN}`);
    note(`Would pin function region: "regions": ["dub1"] in vercel.json (matches Turso aws-eu-west-1)`);
  }
  results.push({ id: "vercel", label: "Vercel project + domain", status: DRY_RUN ? "dry" : "done", notes: "" });
}

// ─── PHASE 3: Backend services (parallel) ────────────────────────────────────

header(3, "Provision backend services");

// Turso
if (step("turso", "Turso → create database")) {
  const dbName = `${PROJECT_NAME}-db`;
  const out = cmd(`turso db create ${dbName} --wait`);
  const urlOut = cmd(`turso db show ${dbName} --url`);
  const tokenOut = cmd(`turso db tokens create ${dbName}`);
  collect("DATABASE_URL", urlOut || `libsql://${dbName}-yourorg.turso.io`);
  collect("DATABASE_AUTH_TOKEN", tokenOut || "[turso-token]");
  results.push({ id: "turso", label: "Turso DB", status: DRY_RUN ? "dry" : "done", notes: `db: ${dbName}` });
}

// Upstash Redis
if (step("upstash-redis", "Upstash → create Redis instance")) {
  if (DRY_RUN) {
    note(`POST https://api.upstash.com/v2/redis/database  { name: "${PROJECT_NAME}-redis" }`);
    collect("UPSTASH_REDIS_URL", "[upstash-redis-url]");
    collect("UPSTASH_REDIS_TOKEN", "[upstash-redis-token]");
  } else {
    const key = env("UPSTASH_MANAGEMENT_API_KEY");
    if (!key) {
      manual("Set UPSTASH_MANAGEMENT_API_KEY in .scaffold-secrets", ["Get it from: upstash.com → Account → Management API"]);
    } else {
      const r = await httpPost(
        "https://api.upstash.com/v2/redis/database",
        { Authorization: `Bearer ${key}` },
        { name: `${PROJECT_NAME}-redis`, region: "eu-west-1", tls: true }
      );
      if (r.ok) {
        collect("UPSTASH_REDIS_URL", r.data.endpoint ? `rediss://${r.data.endpoint}` : "[url]");
        collect("UPSTASH_REDIS_TOKEN", r.data.password || "[token]");
      } else {
        console.error(c(RED, `    ✗ Upstash API error: ${JSON.stringify(r.data)}`));
      }
    }
  }
  results.push({ id: "upstash-redis", label: "Upstash Redis", status: DRY_RUN ? "dry" : "done", notes: "" });
}

// Upstash QStash
if (step("upstash-qstash", "Upstash → get QStash token")) {
  note("QStash is account-wide, not per-DB. Grabbing your token via API.");
  if (DRY_RUN) {
    note(`GET https://api.upstash.com/v2/qstash/keys`);
    collect("QSTASH_URL", "https://qstash.upstash.io");
    collect("QSTASH_TOKEN", "[qstash-token]");
    collect("QSTASH_CURRENT_SIGNING_KEY", "[signing-key]");
    collect("QSTASH_NEXT_SIGNING_KEY", "[next-signing-key]");
  } else {
    const key = env("UPSTASH_MANAGEMENT_API_KEY");
    if (key) {
      const r = await fetch("https://api.upstash.com/v2/qstash/keys", {
        headers: { Authorization: `Bearer ${key}` },
      });
      const data = await r.json().catch(() => ({}));
      collect("QSTASH_URL", "https://qstash.upstash.io");
      collect("QSTASH_TOKEN", data.token || "[token]");
      collect("QSTASH_CURRENT_SIGNING_KEY", data.currentSigningKey || "[key]");
      collect("QSTASH_NEXT_SIGNING_KEY", data.nextSigningKey || "[key]");
    }
  }
  results.push({ id: "upstash-qstash", label: "Upstash QStash", status: DRY_RUN ? "dry" : "done", notes: "" });
}

// Cloudflare R2
if (step("r2", "Cloudflare → create R2 bucket")) {
  const bucketName = `${PROJECT_NAME}-storage`;
  cmd(`wrangler r2 bucket create ${bucketName}`, { note: "Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in env" });
  collect("R2_BUCKET_NAME", bucketName);
    collect("R2_ACCOUNT_ID", env("CLOUDFLARE_ACCOUNT_ID") || "[account-id]");
  collect("R2_ENDPOINT", `https://${env("CLOUDFLARE_ACCOUNT_ID") || "[account-id]"}.r2.cloudflarestorage.com`);
  note("Generate R2 API token: dash.cloudflare.com → R2 → Manage R2 API Tokens");
  collect("R2_ACCESS_KEY_ID", "[r2-access-key]");
  collect("R2_SECRET_ACCESS_KEY", "[r2-secret]");
  results.push({ id: "r2", label: "Cloudflare R2 bucket", status: DRY_RUN ? "dry" : "done", notes: bucketName });
}

// Resend
if (step("resend", "Resend → add domain & create API key")) {
  if (DRY_RUN) {
    note(`POST https://api.resend.com/domains  { name: "${PROJECT_DOMAIN}" }`);
    note(`POST https://api.resend.com/api-keys  { name: "${PROJECT_NAME}", permission: "sending_access", domain_id: "..." }`);
    collect("RESEND_API_KEY", "[resend-api-key]");
    note("DNS records for Resend verification will be returned — add to Vercel DNS in Phase 4");
  } else {
    const key = env("RESEND_API_KEY");
    if (!key) {
      manual("Set RESEND_API_KEY in .scaffold-secrets (your global key)");
    } else {
      const domainRes = await httpPost(
        "https://api.resend.com/domains",
        { Authorization: `Bearer ${key}` },
        { name: PROJECT_DOMAIN }
      );
      if (domainRes.ok) {
        const domainId = domainRes.data.id;
        info(`Domain added: ${domainRes.data.name}`);
        note("DNS records to add to Vercel:");
        for (const r of (domainRes.data.records || [])) {
          console.log(c(YELLOW, `      ${r.record_type} ${r.name} → ${r.value}`));
          collected[`RESEND_DNS_${r.record_type}_${r.name}`] = r.value;
        }
        const keyRes = await httpPost(
          "https://api.resend.com/api-keys",
          { Authorization: `Bearer ${key}` },
          { name: PROJECT_NAME, permission: "sending_access", domain_id: domainId }
        );
        if (keyRes.ok) collect("RESEND_API_KEY", keyRes.data.token);
      } else {
        console.error(c(RED, `    ✗ ${JSON.stringify(domainRes.data)}`));
      }
    }
  }
  results.push({ id: "resend", label: "Resend domain + API key", status: DRY_RUN ? "dry" : "done", notes: "" });
}

// OpenRouter
if (step("openrouter", "OpenRouter → create per-project API key")) {
  if (DRY_RUN) {
    note(`POST https://openrouter.ai/api/v1/keys  { name: "${PROJECT_NAME}-prod" }`);
    note("Requires OPENROUTER_PROVISIONING_KEY — create one at openrouter.ai/settings/keys (type: Provisioning)");
    collect("OPENROUTER_API_KEY", "[openrouter-per-project-key]");
  } else {
    const provKey = env("OPENROUTER_PROVISIONING_KEY");
    if (!provKey) {
      manual(
        "Set OPENROUTER_PROVISIONING_KEY in .scaffold-secrets",
        ["Go to openrouter.ai/settings/keys → Create key → type: Provisioning"]
      );
      collect("OPENROUTER_API_KEY", "[manual]");
    } else {
      const r = await httpPost(
        "https://openrouter.ai/api/v1/keys",
        { Authorization: `Bearer ${provKey}` },
        { name: `${PROJECT_NAME}-prod` }
      );
      if (r.ok) {
        collect("OPENROUTER_API_KEY", r.data.key || r.data.data?.key || "[see response]");
      } else {
        console.error(c(RED, `    ✗ ${JSON.stringify(r.data)}`));
      }
    }
  }
  results.push({ id: "openrouter", label: "OpenRouter API key", status: DRY_RUN ? "dry" : "done", notes: "Per-project key" });
}

// Pollinations
step("pollinations", "Pollinations → API key (MANUAL — no API yet)");
manual(
  "Create a per-project key manually at enter.pollinations.ai",
  [
    "Log in → Settings → Developer Settings → API Keys",
    `Name it: ${PROJECT_NAME}-prod`,
    "Copy the key immediately — shown only once",
  ]
);
collect("POLLINATIONS_API_KEY", "[manual — see enter.pollinations.ai]");
await waitForEnter("Have you copied your Pollinations API key?");
results.push({ id: "pollinations", label: "Pollinations API key", status: "manual", notes: "No API exists yet" });

// VAPID keys (Web Push)
if (step("vapid", "Generate VAPID keypair for Web Push notifications")) {
  if (DRY_RUN) {
    note("npx web-push generate-vapid-keys --json");
    collect("VAPID_PUBLIC_KEY", "[vapid-public-key]");
    collect("VAPID_PRIVATE_KEY", "[vapid-private-key]");
    collect("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "[vapid-public-key]");
  } else {
    try {
      const vapidOut = execSync("npx web-push generate-vapid-keys --json", { encoding: "utf8" }).trim();
      const vapid = JSON.parse(vapidOut);
      collect("VAPID_PUBLIC_KEY", vapid.publicKey);
      collect("VAPID_PRIVATE_KEY", vapid.privateKey);
      collect("NEXT_PUBLIC_VAPID_PUBLIC_KEY", vapid.publicKey);
      info(`VAPID keypair generated (${vapid.publicKey.slice(0, 20)}…)`);
    } catch (e) {
      console.error(c(RED, `    ✗ web-push not available: ${e.message}`));
      manual("Generate VAPID keys manually and add to .scaffold-secrets", [
        "npm install -g web-push  (or: npx web-push generate-vapid-keys --json)",
        "VAPID_PUBLIC_KEY → also copy to NEXT_PUBLIC_VAPID_PUBLIC_KEY",
        "VAPID_PRIVATE_KEY → keep secret, never expose to client",
      ]);
      collect("VAPID_PUBLIC_KEY", "[manual — see web-push generate-vapid-keys]");
      collect("VAPID_PRIVATE_KEY", "[manual]");
      collect("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "[manual — same as VAPID_PUBLIC_KEY]");
    }
  }
  results.push({ id: "vapid", label: "VAPID keypair (Web Push)", status: DRY_RUN ? "dry" : "done", notes: "" });
}

// ─── PHASE 4: DNS pass 1 (what we know so far) ───────────────────────────────

header(4, "DNS on Vercel — first pass");

if (step("dns-pass1", "Vercel DNS → add Resend + email forwarding records")) {
  manual(
    "Add these DNS records in Vercel dashboard",
    [
      `Dashboard → ${PROJECT_NAME} → Settings → Domains → ${PROJECT_DOMAIN} → DNS Records`,
      "Add all Resend DNS records collected above (MX, TXT, CNAME for DKIM)",
      "Add any email forwarding records from Spaceship if applicable",
      "⏳ Clerk and Google records come in Phase 7 after those services are set up",
    ]
  );
  await waitForEnter("First-pass DNS records added?");
  results.push({ id: "dns-pass1", label: "DNS pass 1 (Resend + email)", status: "manual", notes: "" });
}

// ─── PHASE 5: Google Cloud ───────────────────────────────────────────────────

header(5, "Google Cloud — OAuth project (before Clerk — Clerk needs the client ID)");

if (step("google", "Google Cloud → project + OAuth client")) {
  const gcpProject = `${PROJECT_NAME}-prod`;
  cmd(`gcloud projects create ${gcpProject} --name="${PROJECT_NAME}"`, {
    note: "May fail if project ID already taken — try adding a suffix"
  });
  cmd(`gcloud config set project ${gcpProject}`);
  cmd(`gcloud services enable cloudresourcemanager.googleapis.com oauth2.googleapis.com`);

  manual(
    "Configure OAuth consent screen (partially manual — gcloud alpha path is deprecated)",
    [
      `Go to: console.cloud.google.com/auth/overview?project=${gcpProject}`,
      `App name: ${PROJECT_NAME}`,
      "User support email: your email",
      `Privacy policy URL: https://${PROJECT_DOMAIN}/privacy  ← must exist in your template!`,
      `Terms of service URL: https://${PROJECT_DOMAIN}/terms`,
      "Audience: External",
      "Add yourself as test user",
    ]
  );
  await waitForEnter("OAuth consent screen configured?");

  manual(
    "Create OAuth Web Client ID",
    [
      "Go to: console.cloud.google.com/auth/clients",
      "Create credentials → OAuth client ID → Web application",
      `Name: ${PROJECT_NAME}-web`,
      "Authorized redirect URIs: leave blank for now (Clerk URI comes later)",
      "Copy CLIENT_ID and CLIENT_SECRET",
    ]
  );
  await waitForEnter("Have you copied the Google CLIENT_ID and CLIENT_SECRET?");

  manual(
    "Get Google site verification TXT record",
    [
      "Go to: search.google.com/search-console → Add property → Domain",
      `Enter: ${PROJECT_DOMAIN}`,
      "Copy the TXT record value → add to Vercel DNS in Phase 7",
    ]
  );

  collect("GOOGLE_CLIENT_ID", "[from Google Cloud console]");
  collect("GOOGLE_CLIENT_SECRET", "[from Google Cloud console]");
  collect("GOOGLE_VERIFICATION_TXT", "[from Search Console]");
  collect("NEXT_PUBLIC_GOOGLE_PROJECT_ID", gcpProject);

  results.push({ id: "google", label: "Google Cloud OAuth", status: "partial-manual", notes: gcpProject });
}

// ─── PHASE 6: Clerk ──────────────────────────────────────────────────────────

header(6, "Clerk — needs Google client ID from Phase 5");

if (step("clerk", "Clerk → create application & configure")) {
  manual(
    "Create Clerk application (Platform API exists but branding/social config still needs dashboard)",
    [
      "Go to: dashboard.clerk.com → Create application",
      `Name: ${PROJECT_NAME}`,
      "Enable: Email+Password + Google (use CLIENT_ID and CLIENT_SECRET from Phase 5)",
      `Production URL: https://${PROJECT_DOMAIN}`,
      "Set branding: application name, logo (upload from website-assets)",
      "Go to: Configure → Domains → copy all DNS records",
      "Go to: Configure → SSO → Google → copy the Authorized redirect URI",
    ]
  );
  await waitForEnter("Clerk app created and details copied?");

  collect("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "[from Clerk dashboard]");
  collect("CLERK_SECRET_KEY", "[from Clerk dashboard]");
  collect("CLERK_REDIRECT_URI", "[from Clerk SSO config — needed for Google]");
  collect("CLERK_DNS_RECORDS", "[multiple records — see Clerk dashboard → Domains]");

  results.push({ id: "clerk", label: "Clerk application", status: "manual", notes: "" });
}

// ─── PHASE 7: DNS pass 2 ─────────────────────────────────────────────────────

header(7, "DNS on Vercel — second pass (now you have everything)");

if (step("dns-pass2", "Vercel DNS → add Clerk + Google records")) {
  manual(
    "Add remaining DNS records to Vercel",
    [
      `Dashboard → ${PROJECT_NAME} → Settings → Domains → ${PROJECT_DOMAIN}`,
      "Add all Clerk DNS records (CNAME, TXT)",
      "Add Google site verification TXT record",
    ]
  );
  await waitForEnter("Second-pass DNS records added?");
  results.push({ id: "dns-pass2", label: "DNS pass 2 (Clerk + Google)", status: "manual", notes: "" });
}

// ─── PHASE 8: Close Google ↔ Clerk loop ──────────────────────────────────────

header(8, "Close the Google ↔ Clerk loop");

{
  manual(
    "Update Google OAuth client with real Clerk redirect URI",
    [
      "Go to: console.cloud.google.com/auth/clients",
      `Open your ${PROJECT_NAME}-web client`,
      `Add Authorized redirect URI: ${collected.CLERK_REDIRECT_URI || "[from Clerk dashboard]"}`,
      "Save",
      "(Optional) Submit branding for Google verification — takes weeks, do it now to start the clock",
    ]
  );
  await waitForEnter("Google OAuth client updated?");
}

// ─── PHASE 9: Inject all env vars ────────────────────────────────────────────

header(9, "Write all env vars — .env.local + Vercel");

if (step("env", "Write .env.local and push to Vercel")) {
  // Add global keys that come from YOUR vault
  const globalKeys = {
    GEMINI_API_KEY: env("GEMINI_API_KEY") || "[from your vault]",
    POLLINATIONS_API_KEY: collected.POLLINATIONS_API_KEY || "[manual]",
  };

  const allEnv = {
    ...collected,
    ...globalKeys,
    // strip DNS annotation keys
    ...Object.fromEntries(
      Object.entries(collected).filter(([k]) => !k.startsWith("RESEND_DNS_") && !k.startsWith("CLERK_DNS_"))
    ),
  };

  // Clean env — only uppercase keys that look like real env vars
  const envVars = Object.entries(allEnv).filter(
    ([k]) => /^[A-Z][A-Z0-9_]+$/.test(k) && !["CLERK_REDIRECT_URI", "CLERK_DNS_RECORDS", "GOOGLE_VERIFICATION_TXT"].includes(k)
  );

  const envFileContent = [
    `# Generated by scaffold.js — ${new Date().toISOString()}`,
    `# Project: ${PROJECT_NAME} / ${PROJECT_DOMAIN}`,
    "",
    ...envVars.map(([k, v]) => `${k}=${v}`),
  ].join("\n");

  const envPath = DRY_RUN ? `.env.local.${PROJECT_NAME}.example` : `${PROJECT_NAME}/.env.local`;

  writeFileSync(envPath, envFileContent);
  info(`Written to ${envPath}`);

  if (!DRY_RUN) {
    const vercelToken = env("VERCEL_TOKEN");
    if (!vercelToken) {
      manual("Add VERCEL_TOKEN to .scaffold-secrets to push env vars automatically", [
        "Get from: vercel.com/account/tokens → Create Token (scope: Full Account)",
        "Add VERCEL_TOKEN=... to .scaffold-secrets and re-run with --skip spaceship,github,assets,...",
        "Or push env vars manually in Vercel dashboard → Settings → Environment Variables",
      ]);
      note("Env vars written to .env.local only — Vercel push skipped.");
    } else {
      // Read project ID from .vercel/project.json (written by `vercel link` in Phase 2)
      let vercelProjectId = null;
      let vercelTeamId = null;
      const vercelProjectFile = join(PROJECT_NAME, ".vercel", "project.json");
      if (existsSync(vercelProjectFile)) {
        try {
          const proj = JSON.parse(readFileSync(vercelProjectFile, "utf8"));
          vercelProjectId = proj.projectId;
          vercelTeamId = proj.orgId;
        } catch {}
      }
      if (!vercelProjectId) {
        manual("Could not read .vercel/project.json — run Phase 2 (vercel link) first, then re-run with --skip ...,env");
      } else {
        const teamParam = vercelTeamId ? `&teamId=${vercelTeamId}` : "";
        for (const [k, v] of envVars) {
          if (v && !v.startsWith("[")) {
            const r = await httpPost(
              `https://api.vercel.com/v10/projects/${vercelProjectId}/env?upsert=true${teamParam}`,
              { Authorization: `Bearer ${vercelToken}` },
              { key: k, value: v, type: "plain", target: ["production"] }
            );
            if (r.ok) {
              info(`Pushed to Vercel: ${k}`);
            } else {
              console.error(c(RED, `    ✗ Failed to push ${k}: ${r.status} ${JSON.stringify(r.data)}`));
            }
          } else {
            note(`Skipping ${k} — placeholder value, set manually in Vercel dashboard`);
          }
        }
      }
    }
  } else {
    note("Would write to .env.local and push each var via Vercel REST API (POST /v10/projects/{id}/env?upsert=true)");
    note(`Example .env.local written to: ${envPath}`);
  }

  results.push({ id: "env", label: "Env vars", status: DRY_RUN ? "dry" : "done", notes: envPath });
}

// ─── PHASE 10: Deploy ────────────────────────────────────────────────────────

header(10, "Deploy");

if (step("deploy", "Vercel → trigger production deploy")) {
  cmd(`vercel --prod`, { cwd: DRY_RUN ? undefined : PROJECT_NAME });
  results.push({ id: "deploy", label: "Production deploy", status: DRY_RUN ? "dry" : "done", notes: "" });
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

console.log(`\n${c(BOLD, c(CYAN, "═".repeat(60)))}`);
console.log(c(BOLD, `  SCAFFOLD ${DRY_RUN ? "DRY RUN" : "RUN"} COMPLETE — ${PROJECT_NAME} / ${PROJECT_DOMAIN}`));
console.log(c(CYAN, "═".repeat(60)));

console.log(`\n${c(BOLD, "  Step results:")}`);
for (const r of results) {
  const icon =
    r.status === "done" ? c(GREEN, "✓") :
    r.status === "dry" ? c(GREY, "◌") :
    r.status === "skipped" ? c(GREY, "–") :
    r.status === "manual" ? c(YELLOW, "⚠") :
    r.status === "partial-manual" ? c(YELLOW, "◑") : "?";
  console.log(`  ${icon}  ${r.label}${r.notes ? c(GREY, "  (" + r.notes + ")") : ""}`);
}

console.log(`\n${c(BOLD, "  Manual checklist (always):")}`);
const manualItems = [
  `☐ Spaceship: NS pointed to Vercel → ns1.vercel-dns.com, ns2.vercel-dns.com`,
  `☐ Vercel: www.${PROJECT_DOMAIN} → 301 redirect to ${PROJECT_DOMAIN}`,
  `☐ Vercel: DNS records for Resend (MX, DKIM, SPF)`,
  `☐ Vercel: DNS records for Clerk`,
  `☐ Vercel: Google site verification TXT`,
  `☐ Google Cloud: OAuth consent screen configured`,
  `☐ Google Cloud: OAuth client → redirect URI updated with Clerk URI`,
  `☐ Google Cloud: Submit for branding verification (optional, starts the clock)`,
  `☐ Clerk: Application created, Google SSO wired, branding set`,
  `☐ Pollinations: API key created at enter.pollinations.ai`,
  `☐ Vercel: Placeholder env vars filled in manually`,
  `☐ website-assets/${PROJECT_NAME}/: Add logo.png, favicon.ico, og-image.png`,
];
for (const item of manualItems) {
  console.log(c(YELLOW, `  ${item}`));
}

if (DRY_RUN) {
  console.log(c(GREY, `\n  ℹ This was a DRY RUN. Re-run with --run to execute for real.`));
  console.log(c(GREY, `  ℹ Example .env written to: .env.local.${PROJECT_NAME}.example`));
}

// Write run log
const logPath = `scaffold-log-${PROJECT_NAME}-${Date.now()}.json`;
writeFileSync(logPath, JSON.stringify({ project: PROJECT_NAME, domain: PROJECT_DOMAIN, dryRun: DRY_RUN, timestamp: new Date().toISOString(), results, collectedKeys: Object.keys(collected) }, null, 2));
console.log(c(GREY, `\n  Run log saved to: ${logPath}`));
console.log("");


