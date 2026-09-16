# Additional setup script

`provision.sh --with-local-patches` runs one of your own Bash scripts after
DSH is installed and the Android compatibility fixes are applied, before
verification runs. This is the hook to bring a reset phone back to your
personal working setup: provider routes, profiles, boot sidecars, TLS, and
any other host-specific state that the public installer deliberately leaves
alone.

```bash
bash provision.sh --with-local-patches "$HOME/restore-settings.sh"
```

The file must exist before `provision.sh` runs. It runs in a separate Bash
process, so exported variables do not change the installer or future DSH
sessions. A nonzero exit status stops installation.

Write the script idempotently: running it again must not duplicate settings,
overwrite a live file that differs, or launch anything. A typical restore
script probes before writing, backs up differing files, and only installs what
is missing — and it never restarts DSH (the installer does not either).
Restart DSH afterwards when you are ready; sidecars re-ensure on the next
start (or phone reboot).

Keep secrets out of any script you commit or share. Reference environment
variable names (for example `NOUS_API_KEY`) or a local mode-600 secrets
directory; never embed key values.

Without `--with-local-patches`, the installer leaves only the core DSH
machinery behind — the base install needs no personal configuration.
