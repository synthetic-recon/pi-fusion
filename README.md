# pi-fusion

A configurable pi extension that replicates OpenRouter's Fusion behavior using
the authed models pi already has access to.

## What it does

When you invoke the `fusion` tool (or run `/fusion`), pi:

1. Picks a panel of authed models (configurable, default is a diverse panel).
2. Sends your prompt to each model in parallel.
3. Sends all panel responses to a judge model.
4. The judge returns structured analysis:
   - **consensus** — points most models agree on
   - **contradictions** — disagreements with each model's stance
   - **partial_coverage** — points only some models covered
   - **unique_insights** — ideas raised by a single model
   - **blind_spots** — topics no panel model addressed
5. The outer model receives the analysis and raw responses and writes a final answer.

If no config exists, it auto-picks a diverse panel from `ctx.modelRegistry.getAvailable()`.

## Installation

### Option A: install as a pi package (recommended)

```bash
pi install ~/.pi/agent/extensions/pi-fusion
```

Or install globally from npm/git once published:

```bash
pi install npm:pi-fusion
```

### Option B: drop into extensions directory

The files are already at `~/.pi/agent/extensions/pi-fusion/`, so they are
auto-discovered. Run `/reload` in an existing pi session to load them
immediately.

## Configuration

Create one of:

- `~/.pi/agent/fusion.json` (global)
- `<cwd>/.pi/fusion.json` (project-local, overrides global)

Project-local `fusion.json` is only loaded for trusted projects.

Quick-start with the interactive selector or template generator:

```
/fusion-init      # creates .pi/fusion.json template
/fusion-config    # show active config
/fusion-setup     # choose panel and judge via UI
/fusion-run       # choose setup + prompt, then ask the active model to use fusion
```

Example `fusion.json`:

```json
{
  "panel": [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-4.1",
    "google/gemini-2.5-pro"
  ],
  "judge": "anthropic/claude-opus-4-5",
  "maxPanelModels": 3,
  "maxPanelOutputTokens": 2048,
  "maxCompletionTokens": 4096,
  "temperature": 0.3
}
```

### Configuration fields

| Field | Default | Description |
|-------|---------|-------------|
| `panel` | auto-diverse | Array of model identifiers in `provider/id` form. Only authed models are used. |
| `judge` | current model, then first panel model | Model identifier in `provider/id` form. |
| `maxPanelModels` | 3 | Max panel size (1–8). |
| `maxPanelOutputTokens` | 2048 | Max tokens per panel response. |
| `maxCompletionTokens` | 4096 | Max tokens for the judge analysis. |
| `temperature` | 0.3 | Sampling temperature for panel and judge. |

If no config is provided, fusion picks a diverse panel from authed models.

## Usage

### As a tool

Ask the agent to use it:

```
Use fusion to compare the pros and cons of REST vs GraphQL for a new API.
```

The model calls the `fusion` tool, receives the structured analysis, and
answers from multiple perspectives.

### Slash commands

- `/fusion <prompt>` — force the active pi model to call the `fusion` tool, then answer normally.
- `/fusion-report <prompt>` — run fusion directly and write the raw diagnostic panel/judge report into the editor.
- `/fusion-run` — open the setup UI, then enter a prompt, then ask the active model to use fusion in one flow.
- `/fusion-setup` — open the model setup UI to choose panel and judge.
  - **Type** to search/filter models.
  - **Tab** switches focus between search box and list.
  - **↑/↓** navigate the list (works from either focus).
  - **p** or **Space** toggles a model into/out of the panel.
  - **j** sets the highlighted model as judge (press again on the same model to unset).
  - **c** clears all selections.
  - **Enter** confirms.
  - **Esc** cancels.
- `/fusion-config` — view file config + session selection in a native settings list.
- `/fusion-models` — plain text list of authed models.
- `/fusion-init` — generate `.pi/fusion.json` (confirms before overwriting).
- `/fusion-clear` — clear the current session selection.

### Setup UI flow

```
/fusion-run
  → opens Fusion Setup
  → pick panel models and judge
  → press Enter
  → type prompt in editor
  → active pi model calls fusion tool
  → active pi model writes the final answer
```

Or configure once and run later:

```
/fusion-setup    # choose models
/fusion <prompt> # active model uses fusion with those models
```

### Overrides

Override the configured panel or judge per-call:

```
Please use the fusion tool with analysis_models ["anthropic/claude-sonnet-4-5", "openai/gpt-4.1"] and model "anthropic/claude-opus-4-5" to analyze whether we should migrate to Next.js App Router.
```

## How models are resolved

- `provider/id` identifiers are resolved with `ModelRegistry.find(provider, id)`.
- Identifiers without a `provider/` prefix are matched by exact model `id` across all providers.
- Only models that pass `registry.hasConfiguredAuth(model)` are used.
- If an explicitly configured panel model is not authed, it is skipped with a warning.

## Session state

`/fusion-setup` saves the selected panel and judge in the session. On `/resume`,
the extension restores the last selection and shows it in the status line.
Use `/fusion-clear` to remove it.

## Development

```bash
cd ~/.pi/agent/extensions/pi-fusion
npm install   # installs peer deps for type checking
npm run check # TypeScript --noEmit
npm test      # runs the test files under src/__tests__/
```

## Differences from OpenRouter Fusion

- Uses pi's authed models instead of OpenRouter's catalog.
- Does not inject `openrouter:web_search` or `openrouter:web_fetch` into panel/judge calls (pi has its own tools; the outer model can still use them).
- No recursion-depth header is needed because inner calls use `complete()` directly and never see the `fusion` tool.
- Adds interactive panel/judge selection via `/fusion-setup` and `/fusion-run`.
- Adds `/fusion-clear` to reset session selection.
- Adds config validation, preview commands, and session-state persistence.
