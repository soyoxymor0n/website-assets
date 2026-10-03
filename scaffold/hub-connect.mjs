#!/usr/bin/env node
/**
 * hub-connect.mjs - wires a RegOps module to the hub, so nobody has to remember to.
 *
 * Every module that talks to the hub (entitlements, products, classifications, pulses, work items)
 * needs the same two Vercel env vars:
 *
 *   HUB_URL            the hub's origin (https://regops.systems)
 *   HUB_SERVICE_TOKEN  the ONE shared bearer secret the hub's authorizeHubRequest checks. The same value
 *                      on the hub and on every module; it lives once, in .scaffold-secrets, and is never
 *                      printed. (It is pushed as type `sensitive` to Preview and Production, `encrypted`
 *                      to Development, which does not allow sensitive.)
 *
 * scaffold.js runs this as part of building any `reg*` module (Phase 9), so a new module is connected the
 * day it exists. This file is also the retrofit:
 *
 *   node hub-connect.mjs --name regline            dry run for one module
 *   node hub-connect.mjs --name regline --run      do it
 *   node hub-connect.mjs --all --run               every sibling reg* project that has a .vercel link
 *
 * Idempotent, and it never overwrites: a scope that already holds a value keeps it (a module may point
 * Preview at a beta hub on purpose). --force replaces. Never touches the hub's own project.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HUB_PROJECT = 'regops-suite';
export const DEFAULT_HUB_URL = 'https://regops.systems';
const WORKSPACE = resolve(HERE, '..', '..');
const TEAM = 'team_7JHGcnNhlivZXSLbphdg5D6E';

/** Which project names are RegOps modules that talk to the hub. */
export const isHubModule = (name) => /^reg[a-z0-9-]+$/.test(name) && name !== HUB_PROJECT && !/-(verify|promote|perf)$/.test(name);

export function readSecrets() {
  for (const p of [join(homedir(), 'antigravity-workspaces', 'website-assets', '.scaffold-secrets'), resolve(HERE, '..', '.scaffold-secrets')]) {
    if (!existsSync(p)) continue;
    return Object.fromEntries(
      readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_0-9]+=/.test(l))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
        }),
    );
  }
  return {};
}

/** The env vars a module needs, with the Vercel type and scopes of each. Pure, so a test can read the plan. */
export function plan({ hubUrl = DEFAULT_HUB_URL, token }) {
  const rows = [{ key: 'HUB_URL', value: hubUrl, type: 'plain', target: ['production', 'preview', 'development'] }];
  if (token) {
    rows.push({ key: 'HUB_SERVICE_TOKEN', value: token, type: 'sensitive', target: ['production', 'preview'] });
    rows.push({ key: 'HUB_SERVICE_TOKEN', value: token, type: 'encrypted', target: ['development'] });
  }
  return rows;
}

async function api(method, path, token, body) {
  const res = await fetch(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${TEAM}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

/** The Vercel project id of a module: its .vercel link, else a lookup by name. */
export async function projectIdOf(name, vercelToken) {
  const link = join(WORKSPACE, name, '.vercel', 'project.json');
  if (existsSync(link)) {
    try {
      const id = JSON.parse(readFileSync(link, 'utf8')).projectId;
      if (id) return id;
    } catch {
      /* fall through */
    }
  }
  const r = await api('GET', `/v9/projects/${encodeURIComponent(name)}`, vercelToken);
  return r.status === 200 ? r.json.id : null;
}

/** Push the hub env vars to one project. Returns one line per variable; never the token. */
export async function connectHub({ name, vercelToken, hubToken, hubUrl = DEFAULT_HUB_URL, dryRun = true, force = false }) {
  if (!isHubModule(name)) return [{ ok: false, line: `${name}: not a RegOps module, skipped` }];
  const rows = plan({ hubUrl, token: hubToken });
  if (!hubToken) return [{ ok: false, line: `${name}: HUB_SERVICE_TOKEN is not in .scaffold-secrets - add it once and re-run` }];
  if (dryRun) return rows.map((r) => ({ ok: true, line: `${name}: would set ${r.key} (${r.type}) -> ${r.target.join('+')}` }));
  const id = await projectIdOf(name, vercelToken);
  if (!id) return [{ ok: false, line: `${name}: no Vercel project found` }];
  const out = [];
  // A module that already has a value for a scope keeps it (it may point at a beta hub on purpose); --force replaces it.
  const have = new Set();
  if (!force) {
    const cur = await api('GET', `/v9/projects/${id}/env`, vercelToken);
    for (const e of cur.json?.envs ?? []) for (const t of e.target ?? []) have.add(`${e.key}@${t}`);
  }
  for (const r of rows) {
    if (!force && r.target.every((t) => have.has(`${r.key}@${t}`))) {
      out.push({ ok: true, line: `${name}: ${r.key} -> ${r.target.join('+')}: already set, kept` });
      continue;
    }
    const res = await api('POST', `/v10/projects/${id}/env?upsert=true`, vercelToken, { key: r.key, value: r.value, type: r.type, target: r.target });
    out.push({ ok: res.status === 200 || res.status === 201, line: `${name}: ${r.key} (${r.type}) -> ${r.target.join('+')}: ${res.status === 200 || res.status === 201 ? 'set' : `FAILED ${res.status} ${JSON.stringify(res.json?.error?.message ?? '').slice(0, 120)}`}` });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);
  const dryRun = !argv.includes('--run');
  const secrets = readSecrets();
  const names = argv.includes('--all')
    ? readdirSync(WORKSPACE, { withFileTypes: true }).filter((d) => d.isDirectory() && isHubModule(d.name) && existsSync(join(WORKSPACE, d.name, '.vercel', 'project.json'))).map((d) => d.name)
    : [get('--name')].filter(Boolean);
  if (names.length === 0) {
    console.error('Usage: node hub-connect.mjs --name <module> | --all  [--run]');
    process.exit(1);
  }
  let failed = 0;
  for (const name of names) {
    for (const r of await connectHub({ name, vercelToken: secrets.VERCEL_TOKEN, hubToken: secrets.HUB_SERVICE_TOKEN, hubUrl: get('--hub-url') ?? DEFAULT_HUB_URL, dryRun, force: argv.includes('--force') })) {
      console.log(`${r.ok ? ' ok ' : 'FAIL'} ${r.line}`);
      if (!r.ok) failed++;
    }
  }
  if (dryRun) console.log('\nDry run. Add --run to apply.');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
