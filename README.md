# pi-fusion

Multi-model deliberation for [pi](https://github.com/earendil-works), inspired by OpenRouter Fusion.

pi-fusion runs your prompt against a panel of the models you're already authed for, then has a judge model compare their answers and return structured analysis. Your active model uses that analysis to write a better, less-blind-spotted final answer. It works out of the box with no configuration.

## What it does

When the `fusion` tool runs, pi:

1. Picks a panel of authed models (a diverse auto-selection by default, or your configured panel).
2. Sends your prompt to every panel model in parallel.
3. Sends all panel responses to a judge model.
4. The judge returns structured analysis:
   - **consensus** — points most models agree on (treat as higher-confidence)
   - **contradictions** — where models disagree, with each model's stance
   - **partial_coverage** — points only some models raised
   - **unique_insights** — ideas raised by a single model
   - **blind_spots** — topics no panel model addressed
5. Your active model receives the analysis plus the raw responses and writes the final answer.

When two or more panel models answer, the judge synthesis runs. If only one model succeeds, the single response is returned directly (no synthesis).

## Install

```bash
pi install npm:pi-fusion                          # from npm
pi install git:github.com/synthetic-recon/pi-fusion # from GitHub
pi install /path/to/pi-fusion                      # from a local checkout
```

After installing or updating in a running session, run `/reload`.

There's no build step — pi loads the TypeScript directly via [jiti](https://github.com/unjs/jiti).

## Quick start

```
# 1. (optional) pick your panel and judge interactively
/fusion-setup

# 2. just ask — the model decides when fusion is worth it (this is the default)
Use fusion to compare REST vs GraphQL for a new public API.

# 3. or force every prompt through fusion for the session
/fusion on
```

Check what's active any time with `/fusion-status`.

No setup is required: with no panel configured, fusion auto-selects a diverse set of your authed models, and the default mode is `available` (the model calls fusion when a task benefits from it).

## Usage

### As a tool

By default fusion is `available`, so the model can call it whenever a task genuinely benefits from multiple perspectives — research, critique, compare/contrast, architecture trade-offs, or decisions where being wrong is expensive. Just ask:

```
Use fusion to evaluate whether we should migrate to the Next.js App Router.
```

### Session modes

```
/fusion on        # force every prompt through fusion (alias: forced) — needs a panel from /fusion-setup
/fusion available # enable fusion; the model decides when to use it (alias: auto)
/fusion off       # disable fusion and block fusion tool calls for the session (alias: disable)
/fusion           # no argument: toggle between available and forced
```

Typing `/fusion ` offers `on` / `available` / `off` as argument completions. Mode is saved in the session and restored on `/resume`.

### Force fusion for one prompt

Run a single prompt through fusion without changing the session mode:

```
/fusion <prompt>
```

The active model calls fusion, then writes the final answer itself in its normal voice.

### Per-call overrides and context

Override the configured panel or judge for a single call:

```
Use the fusion tool with analysis_models ["anthropic/claude-sonnet-4-5", "openai/gpt-4.1"]
and model "anthropic/claude-opus-4-5" to weigh migrating our build to Bun.
```

Panel and judge calls do **not** see the whole pi conversation thread. When prior context matters, either put the relevant details in the prompt, or ask fusion to include recent turns:

```json
{
  "prompt": "Evaluate the architecture decision we just discussed.",
  "context_mode": "recent",
  "context_turns": 6
}
```

`context_mode` defaults to `"none"`. `context_turns` is clamped to 1–10 (default 4). The judge sees the same context-expanded task the panel saw, plus the panel responses.

### Commands

| Command | What it does |
|---------|--------------|
| `/fusion-setup` | Choose the panel and judge in an interactive picker (interactive mode only). |
| `/fusion on` \| `available` \| `off` | Set the session mode (aliases: `forced`, `auto`, `disable`). |
| `/fusion` | With no argument, toggle between `available` and `forced`. |
| `/fusion <prompt>` | Force fusion for a single prompt, then answer normally. |
| `/fusion-status` | Show the current mode, panel, and judge. |
| `/fusion-report <prompt>` | Run fusion directly and write the raw panel/judge diagnostic report into the editor. |
| `/fusion-init` | Write a `.pi/fusion.json` template (confirms before overwriting; trusted projects only). |

#### `/fusion-setup` controls

- **Type** to search/filter models.
- **Tab** switches focus between the search box and the list.
- **↑/↓** navigate the list (works from either focus).
- **p** or **Space** toggles a model into/out of the panel.
- **j** sets the highlighted model as judge (press again on the same model to unset).
- **c** clears all selections.
- **Enter** confirms, **Esc** cancels.

## Configuration

Configuration is optional. To pin a panel and judge, create either:

- `~/.pi/agent/fusion.json` (global)
- `<cwd>/.pi/fusion.json` (project-local, overrides global — loaded only for trusted projects)

Generate a project-local template with `/fusion-init`, or write one by hand:

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

| Field | Default | Description |
|-------|---------|-------------|
| `panel` | auto-diverse | Model identifiers in `provider/id` form. Only authed models are used. |
| `judge` | current model, then first panel model | Model identifier in `provider/id` form. |
| `maxPanelModels` | 3 | Max panel size (1–8). |
| `maxPanelOutputTokens` | 2048 | Max tokens per panel response. |
| `maxCompletionTokens` | 4096 | Max tokens for the judge analysis. |
| `temperature` | 0.3 | Sampling temperature for panel and judge calls. |

Precedence for both panel and judge: per-call overrides → session selection (`/fusion-setup`) → `fusion.json` → auto-selection.

## How models are resolved

- Reference models as `provider/id` (e.g. `anthropic/claude-sonnet-4-5`). A bare `id` matches by exact id across all providers.
- Only authed models are used; a configured model that isn't authed is skipped with a warning.
- With no panel configured, fusion auto-selects a diverse set (spreading across providers) from your authed models.
- The judge defaults to your current model, falling back to the first panel model.

## Session state

`/fusion-setup` saves the selected panel and judge in the session, and `/fusion` saves the current mode (`available`, `forced`, or `off`). On `/resume`, the extension restores the last selection, mode, and footer state. Use `/fusion off` to fully disable and block fusion for the session.

## Development

```bash
npm install    # installs peer deps for type-checking and tests
npm run check  # tsc --noEmit
npm test       # runs every suite in src/__tests__/
npm pack --dry-run
```

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the GitHub issue templates.

## Differences from OpenRouter Fusion

- Uses pi's authed models instead of OpenRouter's catalog.
- Does not inject `openrouter:web_search` or `openrouter:web_fetch` into panel/judge calls (pi has its own tools; the outer model can still use them).
- No recursion-depth header is needed — inner calls use `complete()` directly and never see the `fusion` tool.
- Adds interactive panel/judge selection via `/fusion-setup`.
- Adds session modes (`available`, `forced`, `off`), diagnostic reports (`/fusion-report`), and session-state persistence.
