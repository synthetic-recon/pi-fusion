# Changelog

## 0.2.1

- Refactored toward OpenRouter-style server-tool semantics.
- `fusion` tool now returns structured JSON-like tool content for the active model to consume.
- `/fusion <prompt>` now force-prompts the active pi model to call the fusion tool and then answer normally.
- Added `/fusion-report <prompt>` for raw panel/judge diagnostic reports.
- Tool calls inherit session panel/judge selection from `/fusion-setup` unless explicit parameters override it.
- Added OpenRouter-compatible `model` judge parameter while keeping `judge_model` as an alias.
- Aligns tool status with OpenRouter: `ok` if at least one panel model succeeds; hard `error` only when all panel models fail.

## 0.2.0

- Redesigned fusion UX around a single setup UI.
- `/fusion-setup` for choosing panel/judge with native pi TUI.
- `/fusion-run` for setup + prompt + run in one flow.
- `/fusion-clear` to reset session selection.
- `/fusion-init` now confirms before overwriting existing `.pi/fusion.json`.
- Setup UI controls: type to search, Tab switches search/list, p/Space toggle panel, j toggle judge, c clear, Enter confirm, Esc cancel.
- Persistent footer status and widget showing current panel and judge.

## 0.1.0

- Initial release.
- `fusion` tool for multi-model deliberation.
- `/fusion`, `/fusion-config`, `/fusion-panel`, `/fusion-models`, `/fusion-init` commands.
- Configurable panel and judge via `~/.pi/agent/fusion.json` or project-local `.pi/fusion.json`.
- Interactive, searchable model selector via `/fusion-panel` using pi's built-in `SelectList` and `Input` components.
- Session-state persistence for panel/judge selections.
- Config validation and model preview commands.
- TypeScript project setup with `npm run check` and `npm test`.
