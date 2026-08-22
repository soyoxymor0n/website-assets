#!/usr/bin/env node
/**
 * push-github-secrets — provision values from `.scaffold-secrets` into a
 * repository's GitHub Actions secrets.
 *
 * The point is to delete a manual step. Some credentials are needed by a
 * repo's CI rather than by the app at runtime (the reMarkable device token is
 * the first), and pasting those into the GitHub UI once per project is
 * exactly the kind of chore that gets skipped and then debugged.
 *
 *   node scaffold/push-github-secrets.mjs --repo soyoxymor0n/myapp \
 *        --secret REMARKABLE_DEVICE_TOKEN
 *
 *   --repo owner/name     repeatable
 *   --secret NAME         repeatable; must exist in .scaffold-secrets
 *   --dry-run             resolve, seal, report - send nothing
 *   --self-test           prove the sealing round-trips, then exit
 *
 * NOTHING SECRET IS EVER PRINTED. Output is names, byte counts and sha256
 * prefixes. The one number that matters when something looks wrong is the
 * fingerprint: it tells you two places hold the same value without either of
 * them showing you what it is.
 *
 * WHY A DEPENDENCY. GitHub will not take a secret in the clear - a value has
 * to be sealed against the repository's own public key with libsodium's
 * `crypto_box_seal` (X25519 + XSalsa20-Poly1305, BLAKE2b-derived nonce). Node
 * ships X25519 and BLAKE2b but not XSalsa20, so this cannot be done with
 * `node:crypto` alone. Every other scaffold script is dependency-free, so
 * rather than break that, this one installs `libsodium-wrappers` into a
 * directory under the OS temp on first run and loads it from there. No
 * package.json anywhere gains a line.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SECRETS_FILE = join(here, '..', '.scaffold-secrets');
const DEPS_DIR = process.env.SCAFFOLD_DEPS_DIR || join(tmpdir(), 'scaffold-deps');

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { repos: [], secrets: [], flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out.flags.add(key);
    } else if (key === 'repo') {
      out.repos.push(next);
      i += 1;
    } else if (key === 'secret') {
      out.secrets.push(next);
      i += 1;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** Enough of dotenv for this file: `KEY=value`, optional quotes, `#` comments. */
export function parseSecretsFile(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/** First 8 hex of sha256 - enough to compare two copies, useless to an attacker. */
const fingerprint = (v) => createHash('sha256').update(v).digest('hex').slice(0, 8);

function loadSodium() {
  const req = createRequire(pathToFileURL(join(DEPS_DIR, 'package.json')).href);
  try {
    return req('libsodium-wrappers');
  } catch {
    process.stdout.write(`Installing libsodium-wrappers into ${DEPS_DIR} (first run only)...\n`);
    mkdirSync(DEPS_DIR, { recursive: true });
    const pkg = join(DEPS_DIR, 'package.json');
    if (!existsSync(pkg)) writeFileSync(pkg, '{"name":"scaffold-deps","private":true}\n');
    execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', 'libsodium-wrappers'], {
      cwd: DEPS_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    return req('libsodium-wrappers');
  }
}

async function gh(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  // These two mean different things and deserve different advice. A
  // fine-grained PAT returns 404 for a repository it cannot SEE at all -
  // deliberately, so a token cannot be used to probe for private repo names -
  // which makes "not found" and "not yours" indistinguishable from here.
  if (res.status === 404) {
    throw new Error(
      `404 on ${path}. Either that repository does not exist, or this token ` +
        `cannot see it - a fine-grained PAT reports both as 404. Check the ` +
        `owner/name first, then the token's repository access.`,
    );
  }
  if (res.status === 403) {
    throw new Error(
      `403 on ${path}. The token can see the repo but lacks the permission: ` +
        `it needs "Secrets: Read and write" (plus "Metadata: Read-only").`,
    );
  }
  if (!res.ok) throw new Error(`${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

/* ------------------------------------------------------------------ */

async function selfTest(sodium) {
  // Prove the sealing before it is ever pointed at a real repository. A
  // wrong implementation does not fail loudly - it writes a secret that
  // decrypts to nothing, and the failure surfaces days later inside a CI run
  // that cannot say why. So: seal against a keypair we own, open it again,
  // and compare.
  const { publicKey, privateKey } = sodium.crypto_box_keypair();
  const message = 'the quick brown fox — äöü 🔐';
  const sealed = sodium.crypto_box_seal(sodium.from_string(message), publicKey);
  const opened = sodium.to_string(sodium.crypto_box_seal_open(sealed, publicKey, privateKey));
  const ok = opened === message;
  process.stdout.write(
    `self-test: seal -> open round-trip ${ok ? 'OK' : 'FAILED'} ` +
      `(${sealed.length} sealed bytes for ${sodium.from_string(message).length} plaintext)\n`,
  );
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sodium = loadSodium();
  await sodium.ready;

  if (args.flags.has('self-test')) {
    await selfTest(sodium);
    return;
  }

  if (!existsSync(SECRETS_FILE)) throw new Error(`No secrets file at ${SECRETS_FILE}`);
  const store = parseSecretsFile(readFileSync(SECRETS_FILE, 'utf8'));

  const token = process.env.GITHUB_TOKEN || store.get('GITHUB_TOKEN');
  if (!token) throw new Error('No GITHUB_TOKEN in the environment or .scaffold-secrets');
  if (!args.repos.length) throw new Error('Nothing to do: pass at least one --repo owner/name');
  if (!args.secrets.length) throw new Error('Nothing to do: pass at least one --secret NAME');

  const missing = args.secrets.filter((n) => !store.has(n));
  if (missing.length) throw new Error(`Not in .scaffold-secrets: ${missing.join(', ')}`);

  // Fail before the first write rather than halfway through a fan-out.
  if (!(await selfTest(sodium))) throw new Error('Refusing to push: sealing is broken.');

  const dry = args.flags.has('dry-run');
  for (const repo of args.repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Not owner/name: ${repo}`);
    const key = await gh(token, `/repos/${repo}/actions/secrets/public-key`);
    // ORIGINAL on BOTH sides. libsodium-wrappers defaults to
    // URLSAFE_NO_PADDING, while GitHub hands out - and expects back -
    // standard base64 with padding; decoding its key with the default variant
    // fails with a bare "incomplete input" naming neither value nor cause.
    const pub = sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL);
    // X25519 public keys are exactly 32 bytes. Checked because this is the one
    // link the self-test above cannot cover: the seal is proven against a
    // keypair we own, but a mis-decoded REPO key would still produce a
    // well-formed ciphertext that GitHub accepts and nothing can ever open -
    // surfacing days later, inside a CI run, as an empty credential.
    if (pub.length !== 32) {
      throw new Error(`${repo}: public key decoded to ${pub.length} bytes, expected 32`);
    }
    process.stdout.write(`\n${repo}  (public key ${key.key_id}, ${pub.length}-byte X25519)\n`);

    for (const name of args.secrets) {
      const value = store.get(name);
      const sealed = sodium.to_base64(
        sodium.crypto_box_seal(sodium.from_string(value), pub),
        sodium.base64_variants.ORIGINAL,
      );
      if (dry) {
        process.stdout.write(`  ${name}  ${value.length}b  sha ${fingerprint(value)}  (dry run)\n`);
        continue;
      }
      await gh(token, `/repos/${repo}/actions/secrets/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ encrypted_value: sealed, key_id: key.key_id }),
      });
      process.stdout.write(`  ${name}  ${value.length}b  sha ${fingerprint(value)}  pushed\n`);
    }
  }
  process.stdout.write(`\n${dry ? 'Dry run - nothing sent.' : 'Done.'}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
