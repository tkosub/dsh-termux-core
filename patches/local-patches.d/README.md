# Local patches hook

`provision.sh` accepts `--with-local-patches <file>` to run a host's own
personal patch file AFTER the public patchers. This is how a dsh-on-Termux
user keeps their device-specific tweaks out of the public repo while still
re-applying them on every install/update.

## Usage

```bash
bash provision.sh --with-local-patches ~/dsh-local-patches.sh
```

Your file is run by `provision.sh` after the version patcher. It can contain
anything your host needs — bridges, relays, model catalog entries, config
edits — but by design it lives OUTSIDE this repo (this repo's `.gitignore`
excludes `dsh-local-patches.sh` and `local-*.sh`).

## What belongs in a local patch file (vs this repo)

- **Local patch file** (`~/dsh-local-patches.sh`): host-specific glue that
  would break a stranger's phone — LAN/TLS bridges, endpoint relays, model
  catalog tunes, boot-layer edits, profile config.
- **This repo's patchers** (`patches/<ver>/`): core Termux/Android fixes any
  user needs — sharp WASM fallback, flock addon, hard-link→rename, launcher
  wrapper.

The classification rule: new core fixes land in the public patchers
(`patches/<ver>/`); new host-specific fixes land in your local file.

## Example

```bash
#!/usr/bin/env bash
# ~/dsh-local-patches.sh — this host's personal patches (NOT in the repo)
set -euo pipefail

# The repo's patchers already did the core fixes; here only host glue:
#   - point a model provider at a private endpoint
#   - write your own profile config / TLS certs / bridges
#   - start your host's sidecar services
# Each of these is host-specific and would break a stranger's phone.

# Example: apply a config edit to a file that exists on this host
if [[ -f ~/.dsh/profiles/web/profile.yml ]]; then
  sed -i 's/^key: old/key: new/' ~/.dsh/profiles/web/profile.yml
fi
```

Keep the file idempotent and non-fatal on missing pieces (`|| true` where
appropriate) — the public base install is fine even if a personal step fails.
