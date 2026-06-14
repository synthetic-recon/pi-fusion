# Contributing to pi-fusion

Thanks for helping improve pi-fusion.

## Development setup

```bash
git clone https://github.com/synthetic-recon/pi-fusion.git
cd pi-fusion
npm install
npm run check
npm test
```

To try the extension locally without installing it globally:

```bash
pi -e .
```

Or install the local package into pi:

```bash
pi install .
```

## Pull requests

Before opening a PR:

1. Run `npm run check`.
2. Run `npm test`.
3. Update `README.md` and `CHANGELOG.md` for user-visible behavior changes.
4. Keep the public workflow simple: `/fusion-setup`, `/fusion`, `/fusion <prompt>`, and `/fusion-status` should remain the primary UX.

## Design principles

- Fusion should behave like an OpenRouter-style server tool: the active pi model calls `fusion`, receives structured analysis, and writes the final answer.
- Forced mode is explicit. When forced mode is off, the active model decides whether fusion is useful.
- Panel and judge calls do not automatically receive conversation context. Use `context_mode: "recent"` only when prior turns matter.
- Prefer native pi TUI components over writing large text blobs into the editor.
- Keep dependencies minimal and list pi runtime packages as peer dependencies.

## Issues

Please include:

- pi version
- pi-fusion version or commit
- install method (`npm`, `git`, or local path)
- command/tool invocation used
- expected behavior
- actual behavior
- relevant config from `~/.pi/agent/fusion.json` or `.pi/fusion.json` with secrets removed
