---
name: scaffold
description: >-
  Provision a new web project's infrastructure (Vercel, Turso, Upstash,
  Cloudflare R2, Clerk, Resend, DNS) or re-provision / rotate keys for an
  existing one. Use when the user says "scaffold / spin up [name] on [domain]"
  or asks to set up the backing services for a new app.
---

# Scaffold a new project's infrastructure

Run from any project — secrets are resolved machine-globally, not from cwd.

**Two data stores per project, always.** Turso and R2 are each provisioned
twice — `{name}-db` + `{name}-db-beta`, `{name}-storage` + `{name}-storage-beta`
— and Phase 9 pushes `_PROD`-suffixed values to Vercel's Production scope and
their unsuffixed twins to Preview + Development. A preview must never touch
production data; a blueprint-based app refuses to start when the pairing is
wrong. Read the `env-isolation` skill before changing anything about which
store a deployment gets.

1. Read `./SCAFFOLD.md` for the full provisioning sequence and flags.
2. Always **dry-run first**, then commit:
   ```bash
   node ./scaffold.js --name "myapp" --domain "myapp.com"          # dry run (default)
   node ./scaffold.js --name "myapp" --domain "myapp.com" --run     # execute
   ```
   Use `--skip <steps>` to re-run a subset (e.g. rotate one service's keys).
3. Secrets load automatically. **The canonical file is
   `website-assets/.scaffold-secrets`** (user-owned, gitignored + untracked
   there, `.example` template beside it - decided 2026-07-18). Resolution
   order: `~/antigravity-workspaces/website-assets/.scaffold-secrets` →
   `../.scaffold-secrets` (script-relative) → `./.scaffold-secrets` (cwd) →
   `~/.claude/scaffold-secrets` (legacy fallback - never put a copy there,
   rotation drift). Refer to keys by name only — never echo their values.
   NOT in any cloud/git backup by design: the recovery path is a Bitwarden
   secure note, kept fresh with `node scaffold/secrets-sync.mjs push` after
   every rotation (`status` to compare, `pull` to restore on a new machine).
   The script needs an unlocked `BW_SESSION` in the shell - it never prompts
   for credentials and never prints secret values. Claude never has a
   standing BW_SESSION (that would decrypt the whole vault, not just this
   note) - when a push is needed, tell the user to double-click
   `scaffold/bw-push.cmd` (prompts once for their master password, pushes,
   discards the session) rather than asking them to run CLI commands by hand.

This skill is the single source of truth in `website-assets/scaffold` and is
exposed globally via a junction in `~/.claude/skills/scaffold`; a `git pull` in
website-assets keeps it current.

## Model choice when delegating a scaffold run
**Sonnet**, not Haiku. Most steps look mechanical (REST calls, DNS records)
but `SCAFFOLD.md`'s own "Known Limitations" section documents several
judgment calls a cheap model tends to get wrong silently: reuse-vs-create
decisions (Upstash free tier = 1 DB max), and an explicit false-positive trap
(Clerk's `PATCH .../oauth_google` 404s — "sloppy error handling can produce a
false positive"). Escalate to Opus only if a step fails in a way that section
doesn't already cover. Regardless of model, DNS/domain/production actions
stay under the standard "destructive steps stay with the main agent" rule —
delegating execution doesn't waive human-in-the-loop for a live domain's
nameservers.
