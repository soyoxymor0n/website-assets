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
// THE CANONICAL FILE IS `website-assets/.scaffold-secrets` (decided 2026-07-18):
// user-owned (survives Claude Code / skill reinstalls, unlike ~/.claude),
// gitignored + untracked in that repo, .example template beside it, and the
// blueprint's create-app.mjs already resolves the same location. The
// well-known workspace path is tried FIRST because the skill COPY of this
// script lives in ~/.claude/skills/scaffold, where the script-relative lookup
// resolves to a path that never exists - that silent miss once left a project
// with an unprovisioned OpenRouter key for weeks. ~/.claude/scaffold-secrets
// is a LEGACY fallback only - do not put a copy there (rotation drift).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SECRETS_CANDIDATES = [
  join(homedir(), "antigravity-workspaces", "website-assets", ".scaffold-secrets"),
  resolve(SCRIPT_DIR, "..", ".scaffold-secrets"),
  resolve(process.cwd(), ".scaffold-secrets"),
  join(homedir(), ".claude", "scaffold-secrets"), // legacy fallback
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

async function httpRequest(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
async function httpPost(url, headers, body) {
  return httpRequest("POST", url, headers, body);
}
async function httpGet(url, headers) {
  return httpRequest("GET", url, headers);
}
async function httpPut(url, headers, body) {
  return httpRequest("PUT", url, headers, body);
}
async function httpPatch(url, headers, body) {
  return httpRequest("PATCH", url, headers, body);
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

// Read one value back from the operator. Anything a provider has no API for
// (Clerk's keys, Google's client secret) has to be pasted exactly once — after
// which it feeds the automation instead of a "[from dashboard]" placeholder.
async function ask(question) {
  if (DRY_RUN) return "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question(c(YELLOW, `    ↳ ${question} `), (a) => { rl.close(); resolve(a.trim()); })
  );
  return answer;
}

// ─── Durable per-app secrets ─────────────────────────────────────────────────

// Providers with no management API (Clerk above all) hand out secrets exactly
// once — the instance sk_live_ is unrecoverable via any endpoint (verified
// 2026-07-17; see "Clerk key RECOVERY" in SCAFFOLD.md). So every pasted secret
// is mirrored into .scaffold-secrets as NAME_<PROJECT>: a deleted Vercel env
// var is never a lockout again, and a re-run / rotation offers the stored copy
// instead of demanding another dashboard dive.
const PROJECT_KEY_SUFFIX = PROJECT_NAME.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const PERSIST_FILE = SECRETS_FILE || resolve(SCRIPT_DIR, "..", ".scaffold-secrets");

function persistSecret(baseName, value) {
  if (DRY_RUN || !value || value.startsWith("[")) return;
  const key = `${baseName}_${PROJECT_KEY_SUFFIX}`;
  let content = existsSync(PERSIST_FILE) ? readFileSync(PERSIST_FILE, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    if (content.match(re)[0] === line) return; // unchanged — don't rewrite
    content = content.replace(re, line); // rotation: replace in place
  } else {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `${line}\n`;
  }
  writeFileSync(PERSIST_FILE, content);
  process.env[key] = value;
  note(`stored ${key} in ${PERSIST_FILE}`);
}

// Ask for a pasted secret, offering the stored per-project copy as the default
// (Enter reuses it; pasting a new value overwrites the stored copy = rotation).
async function askSecret(baseName, question, fallback) {
  const stored = env(`${baseName}_${PROJECT_KEY_SUFFIX}`);
  const value =
    (await ask(
      stored ? `${question} [Enter = stored ${baseName}_${PROJECT_KEY_SUFFIX}]:` : `${question}:`
    )) || stored;
  persistSecret(baseName, value);
  return value || fallback;
}

// ─── Vercel context / DNS ────────────────────────────────────────────────────

// projectId + teamId come from .vercel/project.json (written by `vercel link`
// in Phase 2). teamId is NOT optional when the domain belongs to a team: the
// DNS endpoints answer 403 "You don't have permission to list the domain
// record" without it, which reads like a bad token and isn't.
function vercelCtx() {
  const token = env("VERCEL_TOKEN");
  let projectId = null;
  let teamId = null;
  const projectFile = join(PROJECT_NAME, ".vercel", "project.json");
  if (existsSync(projectFile)) {
    try {
      const p = JSON.parse(readFileSync(projectFile, "utf8"));
      projectId = p.projectId;
      teamId = p.orgId;
    } catch {}
  }
  return { token, projectId, teamId };
}

// Providers describe record names in two different shapes: Clerk returns a
// fully-qualified host ("clk._domainkey.example.com"), Resend returns one
// already relative to the zone ("resend._domainkey"). Vercel wants relative,
// with the apex as an empty string. Normalize both, and never split on the
// first dot — that would turn "clk._domainkey.example.com" into "clk".
function dnsName(host) {
  if (!host || host === PROJECT_DOMAIN) return "";
  return host.endsWith(`.${PROJECT_DOMAIN}`)
    ? host.slice(0, -(PROJECT_DOMAIN.length + 1))
    : host;
}

// Vercel stores CNAME values with a trailing dot ("frontend-api.clerk.services.")
// while Clerk and Resend quote them without one. Compare with the dot ignored or
// every re-run re-adds every record.
const sameValue = (a, b) =>
  String(a ?? "").replace(/\.$/, "") === String(b ?? "").replace(/\.$/, "");

// Records discovered from provider APIs, drained by the two DNS passes.
const pendingDns = { resend: [], clerk: [], google: [] };

let dnsCache = null;
async function syncDnsRecords(label, records) {
  if (!records.length) {
    note(`No ${label} DNS records to add`);
    return;
  }
  if (DRY_RUN) {
    for (const r of records) {
      note(`Would add DNS: ${r.type} ${dnsName(r.host) || "@"} → ${r.value}`);
    }
    return;
  }
  const { token, teamId } = vercelCtx();
  if (!token) {
    manual(
      `Add the ${label} DNS records by hand (VERCEL_TOKEN not set)`,
      records.map((r) => `${r.type} ${dnsName(r.host) || "@"} → ${r.value}`)
    );
    return;
  }
  const teamQ = teamId ? `&teamId=${teamId}` : "";
  if (!dnsCache) {
    const cur = await httpGet(
      `https://api.vercel.com/v4/domains/${PROJECT_DOMAIN}/records?limit=100${teamQ}`,
      { Authorization: `Bearer ${token}` }
    );
    if (!cur.ok) {
      console.error(c(RED, `    ✗ Could not read existing DNS: ${cur.status} ${JSON.stringify(cur.data)}`));
      manual(
        `Add the ${label} DNS records by hand`,
        records.map((r) => `${r.type} ${dnsName(r.host) || "@"} → ${r.value}`)
      );
      return;
    }
    dnsCache = cur.data.records || [];
  }
  for (const rec of records) {
    const name = dnsName(rec.host);
    const already = dnsCache.find(
      (e) => e.type === rec.type && e.name === name && sameValue(e.value, rec.value)
    );
    if (already) {
      note(`Already present: ${rec.type} ${name || "@"} → ${rec.value}`);
      continue;
    }
    const body = { type: rec.type, name, value: rec.value, ttl: 60 };
    if (rec.priority != null) body.mxPriority = rec.priority;
    const r = await httpPost(
      `https://api.vercel.com/v2/domains/${PROJECT_DOMAIN}/records${teamId ? `?teamId=${teamId}` : ""}`,
      { Authorization: `Bearer ${token}` },
      body
    );
    if (r.ok) {
      info(`DNS added: ${rec.type} ${name || "@"} → ${rec.value}`);
      dnsCache.push({ type: rec.type, name, value: rec.value });
    } else {
      console.error(c(RED, `    ✗ DNS ${rec.type} ${name || "@"} failed: ${r.status} ${JSON.stringify(r.data)}`));
      manual(`Add this record by hand`, [`${rec.type} ${name || "@"} → ${rec.value}`]);
    }
  }
}

// Clerk has no API to create an application, but once one exists every DNS
// record the dashboard's "Copy DNS instructions" button shows is available
// from GET /v1/domains — host/value/required per CNAME target.
async function fetchClerkDns(secretKey) {
  if (!secretKey || secretKey.startsWith("[")) return [];
  if (!secretKey.startsWith("sk_live_")) {
    note("Clerk key is not sk_live_ — development instances have no custom domain, so no CNAME targets. Skipping.");
    return [];
  }
  const r = await httpGet("https://api.clerk.com/v1/domains", {
    Authorization: `Bearer ${secretKey}`,
  });
  if (!r.ok) {
    console.error(c(RED, `    ✗ Clerk /v1/domains: ${r.status} ${JSON.stringify(r.data)}`));
    return [];
  }
  const domains = r.data.data || [];
  const d =
    domains.find((x) => x.name === PROJECT_DOMAIN) || domains.find((x) => !x.is_satellite);
  if (!d) {
    manual(`Clerk has no domain matching ${PROJECT_DOMAIN}`, [
      "dashboard.clerk.com → your app → Configure → Domains → add the production domain",
      "Then re-run with: --skip <everything-else> to pick the records up",
    ]);
    return [];
  }
  if (d.frontend_api_url) collect("CLERK_FRONTEND_API_URL", d.frontend_api_url);
  const targets = d.cname_targets || [];
  if (!targets.length) note("Clerk returned no cname_targets — is the production domain added yet?");
  // `required: false` targets are the optional email/DKIM ones; take them too —
  // they cost nothing and Clerk marks the domain fully verified with them.
  return targets.map((t) => ({ type: "CNAME", host: t.host, value: t.value }));
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
  const VERCEL_NS = ["ns1.vercel-dns.com", "ns2.vercel-dns.com"];
  const shipKey = env("SPACESHIP_PUBLISHABLE_KEY") || env("SPACESHIP_API_KEY");
  const shipSecret = env("SPACESHIP_SECRET_KEY");
  const manualNs = () => {
    manual(`Log in to Spaceship and update NS records for ${PROJECT_DOMAIN}`, [
      `Go to: spaceship.com → Domains → ${PROJECT_DOMAIN} → Nameservers`,
      `Set to Vercel's nameservers: ${VERCEL_NS.join(", ")}`,
      "Save — propagation starts now, will be done by the time you reach DNS steps",
    ]);
  };
  let status = "manual-done";
  if (DRY_RUN) {
    note(`PUT https://spaceship.dev/api/v1/domains/${PROJECT_DOMAIN}/nameservers  { provider: "custom", hosts: [${VERCEL_NS.join(", ")}] }`);
    status = "dry";
  } else if (!shipKey || !shipSecret) {
    manualNs();
    await waitForEnter(`Done updating Spaceship NS for ${PROJECT_DOMAIN}?`);
  } else {
    // Spaceship rate-limits this to 5 requests per domain per 300s — one shot,
    // then fall back to the dashboard rather than retrying into a lockout.
    const r = await httpPut(
      `https://spaceship.dev/api/v1/domains/${PROJECT_DOMAIN}/nameservers`,
      { "X-Api-Key": shipKey, "X-Api-Secret": shipSecret },
      { provider: "custom", hosts: VERCEL_NS }
    );
    if (r.ok) {
      info(`Spaceship NS → ${VERCEL_NS.join(", ")} (propagation clock started)`);
      status = "done";
    } else {
      console.error(c(RED, `    ✗ Spaceship API: ${r.status} ${JSON.stringify(r.data)}`));
      manualNs();
      await waitForEnter(`Done updating Spaceship NS for ${PROJECT_DOMAIN}?`);
    }
  }
  results.push({ id: "spaceship", label: "Spaceship NS", status, notes: "Propagation in progress" });
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
    // Resolve project id/team once — reused for productionBranch + the beta
    // branch-domain call below. Both need VERCEL_TOKEN + .vercel/project.json
    // (written by `vercel link` above).
    const vercelToken = env("VERCEL_TOKEN");
    const vercelProjectFile = join(PROJECT_NAME, ".vercel", "project.json");
    let vercelProject = null;
    if (vercelToken && existsSync(vercelProjectFile)) {
      try {
        vercelProject = JSON.parse(readFileSync(vercelProjectFile, "utf8"));
      } catch {}
    }
    const vercelTeamParam = vercelProject?.orgId ? `?teamId=${vercelProject.orgId}` : "";

    // Vercel auto-detects productionBranch from whatever branches exist on
    // the remote AT LINK TIME — if `main` hasn't been pushed yet (e.g. the
    // repo was created manually instead of via create-app.mjs's --github
    // path, which always pushes both), it silently picks `beta` instead,
    // turning every day-to-day push into a production deploy. Set it
    // explicitly rather than trusting auto-detection.
    if (vercelToken && vercelProject) {
      const r = await httpRequest(
        "PATCH",
        `https://api.vercel.com/v9/projects/${vercelProject.projectId}${vercelTeamParam}`,
        { Authorization: `Bearer ${vercelToken}` },
        { productionBranch: "main" }
      );
      if (r.ok) {
        info(`Set productionBranch=main (verify no branch was previously deployed to production unexpectedly)`);
      } else {
        console.error(c(RED, `    ✗ Failed to set productionBranch: ${r.status} ${JSON.stringify(r.data)}`));
        manual("Set the production branch to `main` manually", [
          `Dashboard → ${PROJECT_NAME} → Settings → Git → Production Branch → main`,
        ]);
      }
    } else {
      manual("Set the production branch to `main` (VERCEL_TOKEN not available to automate this)", [
        `Dashboard → ${PROJECT_NAME} → Settings → Git → Production Branch → main`,
        "Do this BEFORE pushing beta for the first time, or beta's first push deploys to production.",
      ]);
    }
    cmd(`vercel domains add ${PROJECT_DOMAIN}`, { cwd: PROJECT_NAME });
    // www → non-www redirect
    cmd(`vercel domains add www.${PROJECT_DOMAIN}`, { cwd: PROJECT_NAME });
    // beta.<domain> scoped to the `beta` git branch — a stable preview URL
    // for day-to-day work instead of an ephemeral *.vercel.app one. Requires
    // the domain's NS to already point at Vercel (Phase 1) — no separate DNS
    // record needed, Vercel manages the zone. `vercel domains add` (CLI) has
    // no branch-scoping flag, so this one has to go through REST.
    const betaDomain = `beta.${PROJECT_DOMAIN}`;
    if (vercelToken && vercelProject) {
      const r = await httpPost(
        `https://api.vercel.com/v10/projects/${vercelProject.projectId}/domains${vercelTeamParam}`,
        { Authorization: `Bearer ${vercelToken}` },
        { name: betaDomain, gitBranch: "beta" }
      );
      if (r.ok) {
        info(`Added ${betaDomain} → scoped to the beta branch`);
      } else {
        console.error(c(RED, `    ✗ Failed to add ${betaDomain}: ${r.status} ${JSON.stringify(r.data)}`));
        manual(`Add ${betaDomain} scoped to the beta git branch manually`, [
          `Dashboard → ${PROJECT_NAME} → Settings → Domains → Add → ${betaDomain} → Git Branch: beta`,
        ]);
      }
    } else {
      manual(`Add ${betaDomain} scoped to the beta git branch (VERCEL_TOKEN not available to automate this)`, [
        `Dashboard → ${PROJECT_NAME} → Settings → Domains → Add → ${betaDomain} → Git Branch: beta`,
      ]);
    }
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
    // www → non-www 301. `vercel domains add` attaches the domain but can't set
    // the redirect; only the project-domain PATCH can.
    if (vercelToken && vercelProject) {
      const r = await httpPatch(
        `https://api.vercel.com/v9/projects/${vercelProject.projectId}/domains/www.${PROJECT_DOMAIN}${vercelTeamParam}`,
        { Authorization: `Bearer ${vercelToken}` },
        { redirect: PROJECT_DOMAIN, redirectStatusCode: 301 }
      );
      if (r.ok) {
        info(`www.${PROJECT_DOMAIN} → 301 → ${PROJECT_DOMAIN}`);
      } else {
        console.error(c(RED, `    ✗ Failed to set www redirect: ${r.status} ${JSON.stringify(r.data)}`));
        manual("Set up www → non-www 301 redirect in Vercel dashboard", [
          `Dashboard → ${PROJECT_NAME} → Settings → Domains`,
          `Set www.${PROJECT_DOMAIN} to redirect (301) to ${PROJECT_DOMAIN}`,
        ]);
      }
    }
  } else {
    cmd(`vercel link`, { note: "Interactive prompt — links repo to Vercel project" });
    note(`Would PATCH productionBranch=main via REST (don't trust Vercel's auto-detection from whatever branches exist on the remote at link time)`);
    cmd(`vercel domains add ${PROJECT_DOMAIN}`);
    cmd(`vercel domains add www.${PROJECT_DOMAIN}`);
    note(`Would POST beta.${PROJECT_DOMAIN} with gitBranch: "beta" via REST (stable preview URL for the beta branch; CLI has no branch-scoping flag)`);
    note(`Would PATCH www.${PROJECT_DOMAIN} → 301 redirect → ${PROJECT_DOMAIN}`);
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
    note("Verification records come back on that response → queued and written to Vercel DNS in Phase 4");
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
        note("DNS records queued for Vercel (added in Phase 4):");
        // Resend's shape: `type` is the DNS type (MX/TXT/CNAME), `record` is the
        // semantic label (SPF/DKIM), `name` is already relative to the zone, and
        // MX rows carry `priority`. There is no `record_type` field.
        for (const rec of (domainRes.data.records || [])) {
          console.log(c(YELLOW, `      ${rec.type} ${rec.name} → ${rec.value}`));
          pendingDns.resend.push({
            type: rec.type,
            host: rec.name,
            value: rec.value,
            priority: rec.priority,
          });
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
  await syncDnsRecords("Resend", pendingDns.resend);
  note("⏳ Clerk and Google records come in Phase 7, once those services exist");
  note("If you use Spaceship email forwarding, add its MX records manually — Resend's API doesn't know about them");
  results.push({
    id: "dns-pass1",
    label: "DNS pass 1 (Resend)",
    status: DRY_RUN ? "dry" : "done",
    notes: `${pendingDns.resend.length} record(s)`,
  });
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

  collect(
    "GOOGLE_CLIENT_ID",
    await askSecret("GOOGLE_CLIENT_ID", "Paste GOOGLE_CLIENT_ID", "[from Google Cloud console]")
  );
  collect(
    "GOOGLE_CLIENT_SECRET",
    await askSecret("GOOGLE_CLIENT_SECRET", "Paste GOOGLE_CLIENT_SECRET", "[from Google Cloud console]")
  );

  manual(
    "Get Google site verification TXT record",
    [
      "Go to: search.google.com/search-console → Add property → Domain",
      `Enter: ${PROJECT_DOMAIN}`,
      "Copy the TXT value — paste it below and Phase 7 writes it to DNS for you",
    ]
  );
  const gVerify = await ask("Paste the google-site-verification=… TXT value (Enter to skip):");
  if (gVerify) {
    collect("GOOGLE_VERIFICATION_TXT", gVerify);
    pendingDns.google.push({ type: "TXT", host: PROJECT_DOMAIN, value: gVerify });
  } else {
    collect("GOOGLE_VERIFICATION_TXT", "[from Search Console]");
  }
  collect("NEXT_PUBLIC_GOOGLE_PROJECT_ID", gcpProject);

  results.push({ id: "google", label: "Google Cloud OAuth", status: "partial-manual", notes: gcpProject });
}

// ─── PHASE 6: Clerk ──────────────────────────────────────────────────────────

header(6, "Clerk — needs Google client ID from Phase 5");

if (step("clerk", "Clerk → create application & configure")) {
  manual(
    "Create Clerk application (no public API creates one — dashboard only)",
    [
      "Go to: dashboard.clerk.com → Create application",
      `Name: ${PROJECT_NAME}`,
      "Enable: Email+Password + Google (use CLIENT_ID and CLIENT_SECRET from Phase 5)",
      `Production URL: https://${PROJECT_DOMAIN}`,
      "Set branding: application name, logo (upload from website-assets)",
      `Go to: Configure → Domains → add ${PROJECT_DOMAIN}`,
      "  (you do NOT need to copy the DNS records — we pull them from the API below)",
      "Go to: Configure → SSO → Google → copy the Authorized redirect URI",
    ]
  );
  await waitForEnter("Clerk app created, domain added, Google SSO configured?");

  collect(
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    await askSecret(
      "CLERK_PUBLISHABLE_KEY",
      "Paste the Clerk publishable key (pk_live_…)",
      "[from Clerk dashboard]"
    )
  );
  const clerkSecret = await askSecret("CLERK_SECRET_KEY", "Paste the Clerk secret key (sk_live_…)", "");
  collect("CLERK_SECRET_KEY", clerkSecret || "[from Clerk dashboard]");
  // Not derivable: the Google callback is NOT ${frontend_api_url}/v1/oauth_callback
  // (that path 404s on a healthy production instance), and Clerk exposes no
  // endpoint for it. Copying it from the dashboard is the only reliable route.
  collect(
    "CLERK_REDIRECT_URI",
    await askSecret(
      "CLERK_REDIRECT_URI",
      "Paste the Clerk → SSO → Google Authorized redirect URI",
      "[from Clerk SSO config — needed for Google]"
    )
  );

  if (DRY_RUN) {
    note("GET https://api.clerk.com/v1/domains  (Bearer sk_live_…) → cname_targets[] → queued for Phase 7");
  } else {
    pendingDns.clerk = await fetchClerkDns(clerkSecret);
    if (pendingDns.clerk.length) {
      info(`Clerk returned ${pendingDns.clerk.length} CNAME target(s) — queued for Phase 7`);
      for (const r of pendingDns.clerk) note(`  ${r.type} ${dnsName(r.host) || "@"} → ${r.value}`);
    }
  }

  results.push({
    id: "clerk",
    label: "Clerk application",
    status: "partial-manual",
    notes: `${pendingDns.clerk.length} DNS record(s) via API`,
  });
}

// ─── PHASE 7: DNS pass 2 ─────────────────────────────────────────────────────

header(7, "DNS on Vercel — second pass (now you have everything)");

if (step("dns-pass2", "Vercel DNS → add Clerk + Google records")) {
  await syncDnsRecords("Clerk", pendingDns.clerk);
  await syncDnsRecords("Google verification", pendingDns.google);
  const total = pendingDns.clerk.length + pendingDns.google.length;
  results.push({
    id: "dns-pass2",
    label: "DNS pass 2 (Clerk + Google)",
    status: DRY_RUN ? "dry" : "done",
    notes: `${total} record(s)`,
  });
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

// Only things with no API path belong here. Anything the script now does
// itself (Spaceship NS, all DNS, the www redirect) is deliberately absent —
// a checklist that lists automated work trains you to ignore the checklist.
console.log(`\n${c(BOLD, "  Manual checklist — no API exists for these:")}`);
const manualItems = [
  `☐ Clerk: Application created + production domain added (dashboard only)`,
  `☐ Clerk: Google SSO custom credentials pasted (PATCH .../oauth_google 404s — dashboard only)`,
  `☐ Clerk: Branding — application name + logo`,
  `☐ Google Cloud: OAuth consent screen configured`,
  `☐ Google Cloud: OAuth client → redirect URI updated with the Clerk URI`,
  `☐ Google Cloud: Submit for branding verification (optional, starts a weeks-long clock)`,
  `☐ Pollinations: API key created at enter.pollinations.ai`,
  `☐ website-assets/${PROJECT_NAME}/: Add logo.png, favicon.ico, og-image.png`,
];
for (const item of manualItems) {
  console.log(c(YELLOW, `  ${item}`));
}

// In a dry run every value is a placeholder by construction, so this would be
// noise. Only worth printing after a real run, where it's the true remainder.
const placeholders = DRY_RUN
  ? []
  : Object.entries(collected).filter(([, v]) => String(v).startsWith("["));
if (placeholders.length) {
  console.log(`\n${c(BOLD, "  Env vars still holding placeholders — set these by hand:")}`);
  for (const [k] of placeholders) console.log(c(YELLOW, `  ☐ ${k}`));
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


