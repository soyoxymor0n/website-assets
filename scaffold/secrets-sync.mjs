#!/usr/bin/env node
/**
 * secrets-sync — keep the canonical `.scaffold-secrets` file mirrored into
 * Bitwarden as ONE secure note (the whole file as the note body - no custom
 * fields, no copy/paste). The vault is the recovery path; this script is how
 * it stays fresh after every rotation.
 *
 *   node scaffold/secrets-sync.mjs status   # local vs vault (hashes only)
 *   node scaffold/secrets-sync.mjs push     # local file  -> vault note
 *   node scaffold/secrets-sync.mjs pull     # vault note  -> local file (backs up the old one)
 *
 * Auth is YOURS, never this script's: it uses the Bitwarden CLI with an
 * existing session and refuses to prompt for anything. One-time per shell:
 *
 *   bw login                        # first time only
 *   bw unlock                       # prints an export line
 *   $env:BW_SESSION="..."           # paste it (PowerShell), then run this script
 *
 * Nothing secret is ever printed - output is byte counts + sha256 prefixes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ITEM_NAME = 'scaffold-secrets';
const SECRETS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.scaffold-secrets');

const cmd = process.argv[2];
if (!['push', 'pull', 'status'].includes(cmd ?? '')) {
  console.log('usage: node secrets-sync.mjs <status|push|pull>');
  process.exit(2);
}

/** Run bw non-interactively; shell:false, .cmd resolution for Windows. */
function bw(args, input) {
  const exe = process.platform === 'win32' ? 'bw.cmd' : 'bw';
  return execFileSync(exe, [...args, '--nointeraction'], {
    input,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32', // .cmd needs a shell on Windows
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

// ---- preflight: session must already exist; we never ask for credentials ----
let vaultStatus;
try {
  vaultStatus = JSON.parse(bw(['status']));
} catch {
  console.error('✗ Bitwarden CLI not reachable. Install with: npm i -g @bitwarden/cli');
  process.exit(1);
}
if (vaultStatus.status !== 'unlocked') {
  console.error(`✗ Vault is '${vaultStatus.status}'. Run \`bw login\` (first time) / \`bw unlock\`,`);
  console.error('  set the printed BW_SESSION in this shell, then re-run.');
  process.exit(1);
}

try {
  bw(['sync']);
} catch {
  console.warn('! bw sync failed (offline?) - continuing with the local vault cache.');
}

// ---- locate the vault item (exact name match) ----
const found = JSON.parse(bw(['list', 'items', '--search', ITEM_NAME]));
const items = found.filter((i) => i.name === ITEM_NAME);
if (items.length > 1) {
  console.error(`✗ ${items.length} vault items named '${ITEM_NAME}' - delete the duplicates first.`);
  process.exit(1);
}
const item = items[0] ?? null;

const local = existsSync(SECRETS_FILE) ? readFileSync(SECRETS_FILE, 'utf8') : null;
const remote = item?.notes ?? null;

const describe = (label, s) =>
  console.log(`  ${label}: ${s == null ? 'MISSING' : `${Buffer.byteLength(s)} bytes, sha ${sha(s)}`}`);

if (cmd === 'status') {
  describe('local ', local);
  describe('vault ', remote);
  if (local != null && remote != null) {
    console.log(local === remote ? '✓ in sync' : '✗ DIFFER - push or pull to reconcile');
  }
  process.exit(0);
}

if (cmd === 'push') {
  if (local == null) {
    console.error(`✗ No local file at ${SECRETS_FILE}`);
    process.exit(1);
  }
  if (remote === local) {
    console.log('✓ vault already up to date');
    process.exit(0);
  }
  if (item) {
    const updated = { ...item, notes: local };
    bw(['edit', 'item', item.id, Buffer.from(JSON.stringify(updated)).toString('base64')]);
    console.log(`✓ vault note '${ITEM_NAME}' updated (${Buffer.byteLength(local)} bytes, sha ${sha(local)})`);
  } else {
    const fresh = {
      type: 2, // secure note
      secureNote: { type: 0 },
      name: ITEM_NAME,
      notes: local,
      favorite: false,
      collectionIds: [],
    };
    bw(['create', 'item', Buffer.from(JSON.stringify(fresh)).toString('base64')]);
    console.log(`✓ vault note '${ITEM_NAME}' created (${Buffer.byteLength(local)} bytes, sha ${sha(local)})`);
  }
  process.exit(0);
}

if (cmd === 'pull') {
  if (remote == null) {
    console.error(`✗ No vault item named '${ITEM_NAME}' (or its note body is empty). Push first.`);
    process.exit(1);
  }
  if (remote === local) {
    console.log('✓ local file already up to date');
    process.exit(0);
  }
  if (local != null) {
    const bak = `${SECRETS_FILE}.bak-${new Date().toISOString().slice(0, 10)}`;
    renameSync(SECRETS_FILE, bak);
    console.log(`  previous file kept as ${bak} (gitignored; delete once confident)`);
  }
  writeFileSync(SECRETS_FILE, remote, 'utf8');
  console.log(`✓ local file restored from vault (${Buffer.byteLength(remote)} bytes, sha ${sha(remote)})`);
  process.exit(0);
}
