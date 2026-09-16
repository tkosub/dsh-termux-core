# DSH for Termux

Install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
on an Android phone using Termux. This installer supports **DSH 0.1.5-rc.1**,
the release candidate, on **ARM64 phones with Android 11 or newer**.

## Install

Install [Termux](https://github.com/termux/termux-app#installation), open it,
and run:

```bash
pkg update
pkg install -y git
git clone https://github.com/tkosub/dsh-termux-core.git
cd dsh-termux-core
bash provision.sh
```

The script installs the required software, applies the Android fixes, and
checks file locking, file creation, image handling, terminal commands, and
file search. It stops with an error if a required step fails.

Start DSH:

```bash
dsh web
```

Open the **complete address printed by DSH** in your phone's browser,
including its access token. Configure your model provider in **Settings →
Models**. A provider account and API key may be required; neither is included.
For DeepSeek, you can also set `DEEPSEEK_API_KEY` before starting DSH.

Keep Termux open while using DSH. To stop the server, press **Ctrl+C** in
its terminal. Android may stop background applications; automatic startup
and remote access are not configured by this installer.

## Update or repair

Finish your current work and stop DSH, then run:

```bash
cd ~/dsh-termux-core
git pull --ff-only
bash provision.sh
dsh web
```

A normal run keeps the matching DSH package and reapplies its fixes.
Use `bash provision.sh --force` to reinstall that package too. Your DSH
settings and conversations are not changed. The script does not restart DSH.

If an installation check fails, keep its error message and see the
[troubleshooting instructions](docs/upgrade-runbook.md). A version number
alone does not establish that all tools work. The remaining acceptance
check is to start DSH, send a prompt, and save and reopen a conversation.

## Optional features

- [Browser and web tools](browser/README.md): separate setup; not required for DSH.
- [Run an additional setup script](patches/local-patches.d/README.md).
- [Compatibility fixes and tested versions](docs/patch-matrix.md).
- [Development checks](docs/verification.md).

## License

MIT. Third-party attribution is recorded in [NOTICE](NOTICE).
