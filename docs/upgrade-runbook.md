# Update and troubleshooting

Stop DSH after finishing your work, update this repository with
`git pull --ff-only`, and run `bash provision.sh` again. Start DSH with
`dsh web` after the checks pass. No separate patch commands are needed.

| Message or symptom | What to do |
|---|---|
| Package download failed | Check the connection, run `termux-change-repo` if necessary, and retry. |
| Unsupported Android version or architecture | This release requires Android 11+ and ARM64. |
| Node.js headers missing | Reinstall the Termux Node.js package with `pkg reinstall nodejs` (or `nodejs-lts` if that is the package you use). |
| Unrecognized package version or source | Update this repository. If the error remains, report it; do not force a patch onto unfamiliar code. |
| Native file support missing or outdated | Run the installer again. If you set `DSH_FLOCK_PREBUILD_DIR`, use the same value when installing and running DSH. |
| Checks fail on an existing installation | Retry with `bash provision.sh --force` to rebuild the DSH package. Keep the complete failure message if it still fails. |
| Browser asks for access or rejects an old link | Open the complete address from the current `dsh web` launch, including the token. |

To rerun only the functional checks:

```bash
node scripts/verify.mjs "$(npm root -g)/@deepseek-ai/dsh"
```

Then use the web interface to send a prompt, create and edit a file, search
its contents, and reopen the conversation after restarting DSH. These
checks exercise the application and your chosen provider together.

`--force` replaces installed application code, including changes made
directly inside that code. It does not erase conversations or settings.
Back up `$HOME/.dsh` before changing DSH versions. This repository does not
provide an automatic rollback to a different DSH release.
