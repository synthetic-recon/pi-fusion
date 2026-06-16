# Changelog

## 0.7.2

- A panel model that returns no text (e.g. it spent its turns on tools, hit the loop guard, or ran out of token budget) is now reported as a **failed** panel instead of a blank "successful" response, so the judge only synthesizes real answers.
- The panel tool-loop circuit breaker now trips only on a **tight** stuck-loop — the exact same tool call (tool + arguments) 3× in a row, or 3 consecutive errors. Varied tool use (same tool, different paths/queries) no longer counts toward it.

## 0.7.1

- Add a README banner and a package gallery image (`pi.image`) so listings show artwork.
- CI/release workflows bumped to `actions/checkout@v6` + `actions/setup-node@v6` (Dependabot).

## 0.7.0

- **Panel/judge are now always user configuration.** The `fusion` tool no longer exposes `analysis_models`/`model`/`judge_model` parameters, so the invoking model can't auto-pick (or override) your models. Panel/judge come from `/fusion-setup` → `fusion.json` → auto-selection. (Also removes spurious "model not authed" warnings caused by the model guessing models.)
- The footer and `/fusion-status` now reflect a `fusion.json` panel/judge even without running `/fusion-setup`.
- Redesigned `/fusion-setup`: rows show provider · model name · panel/judge badges (right column, no longer truncated); panel and judge are now **independent** toggles; a live list of selected panel models + judge shows at top; config (tools, max calls) moved to a Tab-navigable section; `/` search sub-mode.
- `/fusion-init` now creates the `.pi/` directory if missing (fixes an ENOENT) and seeds the template from your **authed** models, so it works immediately without "model not authed" warnings.
- Panel models can now run a bounded internal **tool loop** (multi-turn) before answering.
- `panelTools` config / `panel_tools` tool param: `"none"` (default), `"readonly"` (read/grep/find/ls), `"all"` (adds bash/edit/write), or an explicit tool-name list.
- `maxToolCalls` config / `max_tool_calls` tool param caps tool-call steps per panel model (1–100, default 8; `/fusion-setup` presets 4/8/12/25/50/100).
- `all`/mutating tools are off by default, require consent, and serialize the panel; without consent they downgrade to read-only.
- `/fusion-setup` config (panel tools, max calls) is a Tab-navigable section; the judge stays tool-free.

## 0.6.0

- `/fusion` now offers argument autocompletion for `on` (alias for `forced`), `available`, and `off`.
- Require Node >= 22.19.0 (matches the pi runtime); CI now runs on Node 22.
- Fixed the test runner so every suite under `src/__tests__/` runs (previously only the first file executed).
- Removed dead code left over from the legacy-command cleanup (no behavior change).
- Rewrote the README and updated the GitHub org slug to `synthetic-recon`.

## 0.5.0

- Added explicit three-state session mode: `available`, `forced`, and `off`.
- `/fusion off` now fully disables fusion for the session and blocks `fusion` tool calls.
- `/fusion available` re-enables model-decided fusion use.
- `/fusion forced` forces every normal prompt through fusion.
- `/fusion` with no args toggles between `available` and `forced`.
- Removed legacy commands: `/fusion-run`, `/fusion-models`, `/fusion-clear`, and `/fusion-config`.
- Footer/status now reflects `Fusion available`, `Fusion forced`, or `Fusion off`.

## 0.4.0

- Added optional recent conversation context for fusion tool calls.
- New tool parameters: `context_mode: "none" | "recent"` and `context_turns` (1–10, default 4).
- Panel models receive the context-expanded task when requested.
- Judge receives the same context-expanded task the panel saw, plus panel responses.
- Tool guidance now tells the active model to request recent context only when prior turns matter.
- Added context helper tests.

## 0.3.2

- Clarified Fusion mode semantics: ON means forced for every normal prompt; OFF means the tool remains available for model-decided use.
- Strengthened tool guidance to match OpenRouter: use fusion only for tasks that benefit from multiple perspectives, critique, research, comparison, or high-stakes decisions.
- Footer/status now says `Fusion forced` or `Fusion available` instead of ambiguous on/off wording.

## 0.3.1

- Fixed footer/run mismatch where an explicit 4-model session panel displayed as 4 in the footer but only ran 3 models.
- Session-selected panels now run all selected models up to the hard limit of 8.
- Auto-selected panels still default to 3 models.
- Added regression tests for explicit session panel size vs auto default size.

## 0.3.0

- Simplified operation around one session toggle.
- `/fusion` with no args now toggles Fusion mode on/off for the current session.
- `/fusion <prompt>` remains a one-shot force-fusion command.
- Added `/fusion-status` for current mode/panel/judge.
- Normal prompts are automatically transformed to use the fusion tool when Fusion mode is on.
- Footer now shows `Fusion on/off • N panel • judge ...` on the right.
- Kept `/fusion-report`, `/fusion-run`, `/fusion-config`, `/fusion-models`, and `/fusion-clear` as advanced/debug commands.

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
