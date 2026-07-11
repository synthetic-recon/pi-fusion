<p align="center">
  <img alt="NPM Downloads" src="https://img.shields.io/npm/dw/pi-fusion">
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/synthetic-recon/pi-fusion/main/assets/fusion.png" alt="pi-fusion" width="520">
</p>

# pi-fusion

Multi-model deliberation for [pi](https://pi.dev/), inspired by [OpenRouter Fusion](https://openrouter.ai/blog/announcements/fusion-beats-frontier/).

pi-fusion sends your prompt to several of the models you're already authed for, then has a judge model compare their answers. The judge's analysis (where the models agree, disagree, or each missed something) goes back to your active model, which writes the final answer. It needs no configuration to start.

## When it helps

Running several models is slower and costs more tokens than one, so it's worth it when a second or third opinion changes the outcome: research, architecture trade-offs, critiques, and decisions that are expensive to get wrong. For routine edits it adds little. By default fusion only runs when the active model judges a task worth it, so most prompts are unaffected.

What you get from a panel that you don't from one model:

- Agreement across independent models is a stronger signal than one model's confidence.
- Disagreement is reported per model rather than averaged away, so you can see what's actually contested.
- A single model has consistent blind spots. Models from different providers tend not to share them, so the panel covers points any one model misses.

## What it does

When the `fusion` tool runs, pi:

1. Picks a panel of authed models (a diverse auto-selection by default, or your configured panel).
2. Sends your prompt to every panel model in parallel.
3. Sends all panel responses to a judge model, which returns structured analysis:
   - **consensus**: points most models agree on (treat as higher-confidence)
   - **contradictions**: where models disagree, with each model's stance
   - **partial_coverage**: points only some models raised
   - **unique_insights**: ideas raised by a single model
   - **blind_spots**: topics no panel model addressed
4. Your active model receives the analysis plus the raw responses and writes the final answer.

When two or more panel models answer, the judge synthesis runs. If only one model succeeds, the single response is returned directly (no synthesis).

## Install

```bash
pi install npm:pi-fusion                            # from npm
pi install git:github.com/synthetic-recon/pi-fusion # from GitHub
pi install /path/to/pi-fusion                       # from a local checkout
```

After installing or updating in a running session, run `/reload`.

There's no build step; pi loads the TypeScript directly via [jiti](https://github.com/unjs/jiti). Requires Node ≥ 22.19.0 and Pi ≥ 0.74.0.

## Quick start

```
# 1. (optional) pick your panel and judge interactively
/fusion-setup

# 2. just ask; the model decides when fusion is worth it (this is the default)
Use fusion to compare REST vs GraphQL for a new public API.

# 3. or force every prompt through fusion for the session
/fusion on
```

Check what's active any time with `/fusion-status`.

No setup is required: with no panel configured, fusion auto-selects a diverse set of your authed models, and the default mode is `available` (the model calls fusion when a task benefits from it).

## Usage

### As a tool

By default fusion is `available`, so the model can call it whenever a task genuinely benefits from multiple perspectives. Just ask:

```
Use fusion to evaluate whether we should migrate to the Next.js App Router.
```

### Session modes

```
/fusion on        # force every prompt through fusion (alias: forced); needs a panel from /fusion-setup
/fusion available # enable fusion; the model decides when to use it (alias: auto)
/fusion off       # disable fusion and block fusion tool calls for the session (alias: disable)
/fusion           # no argument: toggle between available and forced
```

Typing `/fusion ` offers `on` / `available` / `off` as argument completions. Mode is saved in the session and restored on `/resume`.

### Force fusion for one prompt

Run a single prompt through fusion without changing the session mode:

```
/fusion <prompt>
/fusion --panel quality <prompt>
```

The active model calls fusion, then writes the final answer itself in its normal voice. `--panel <name>` selects a configured named panel for that agent run only; the next run returns to the session/default selection. This stateful `/fusion --panel` form requires interactive mode. In print mode, use `/fusion-report --panel <name> <prompt>` to run the named panel directly.

### Adding conversation context

**All fusion config is yours** — panel, judge, tool access, max tool calls, temperature, and token budgets are set via `/fusion-setup` (session) or `fusion.json`, and the model invoking the tool cannot pick or override any of them. It only supplies the prompt (and may choose whether to include recent conversation context).

Panel and judge calls do **not** see the whole pi conversation thread. When prior context matters, either put the relevant details in the prompt, or ask fusion to include recent turns:

```json
{
  "prompt": "Evaluate the architecture decision we just discussed.",
  "context_mode": "recent",
  "context_turns": 6
}
```

`context_mode` defaults to `"none"`. `context_turns` is clamped to 1–10 (default 4). The judge sees the same context-expanded task the panel saw, plus the panel responses.

## Configuration

Configuration is optional. To pin a panel and judge, create either:

- `~/.pi/agent/fusion.json` (global)
- `<cwd>/.pi/fusion.json` (project-local, overrides global; loaded only for trusted projects)

Generate a project-local template with `/fusion-init`, or write one by hand. Named panels let you keep reusable cost/quality trade-offs without editing the file between runs:

```json
{
  "defaultPanel": "quality",
  "panelReasoning": "medium",
  "judgeReasoning": "high",
  "panels": {
    "quality": {
      "models": [
        "openai/gpt-5.5",
        "z-ai/glm-5.2",
        "moonshotai/kimi-2.7"
      ],
      "judge": "anthropic/claude-opus-4-8",
      "panelReasoning": "high",
      "judgeReasoning": "xhigh"
    },
    "fast": {
      "models": ["openai/gpt-5.5-mini", "google/gemini-2.5-flash"],
      "judge": "openai/gpt-5.5-mini",
      "panelReasoning": "low"
    }
  },
  "maxPanelModels": 3,
  "maxPanelOutputTokens": 2048,
  "maxCompletionTokens": 4096,
  "temperature": 0.3,
  "panelTools": "none",
  "maxToolCalls": 16,
  "footerDisplay": "full"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `panels` | none | Reusable named panels. Each entry requires `models` and may set `judge`, `panelReasoning`, and `judgeReasoning`. |
| `defaultPanel` | none | Named panel used when there is no one-shot or session selection. An invalid default warns and falls through to legacy or auto selection. |
| `panel` | auto-diverse | Legacy top-level model identifiers in `provider/id` form. Still supported; only authed models are used. |
| `judge` | current model, then first panel model | Legacy/default judge model identifier in `provider/id` form. Named panels inherit it when they omit `judge`. |
| `panelReasoning` | provider default | Reasoning effort for panel calls: `minimal`, `low`, `medium`, `high`, or `xhigh`. Named panels may override it. |
| `judgeReasoning` | provider default | Independent reasoning effort for judge synthesis, using the same levels. Named panels may override it. |
| `maxPanelModels` | 3 | Max panel size (1–8). |
| `maxPanelOutputTokens` | 2048 | Max tokens per panel response. |
| `maxCompletionTokens` | 4096 | Max tokens for the judge analysis. |
| `temperature` | 0.3 | Sampling temperature for panel and judge calls. |
| `panelTools` | `"none"` | Panel tool access: `"none"`, `"readonly"` (read/grep/find/ls), `"all"` (adds bash/edit/write), or an explicit tool-name list (e.g. `["read", "grep"]`). The list form is **config-file only**. |
| `maxToolCalls` | 16 | Max tool-call steps **per panel model** when tools are on (1–100). Models batch several calls per turn, so this is the per-agent budget; total ≈ panel size × this. |
| `panelToolsConsent` | `false` | Pre-authorize mutating tools in non-interactive (`-p`) runs. |
| `footerDisplay` | `"full"` | Fusion status verbosity: `"full"` includes mode, active named panel, panel count, reasoning, judge, and tools; `"compact"` shows mode + panel count; `"off"` clears only Fusion's keyed status. The legacy key name is retained for compatibility. |

**Precedence.** Everything resolves one-shot `--panel` selection → session snapshot (`/fusion-setup`) → `defaultPanel` → legacy top-level `panel`/`judge` → auto-selection. Project-local config replaces global config rather than merging with it. An explicit unknown, malformed, empty, or unusable named panel fails before any provider call; an invalid `defaultPanel` warns and continues through legacy/auto selection. The invoking model can't override any of this (the tool takes only the prompt + optional context controls).

**How models are resolved.** Reference models as `provider/id` (e.g. `openai/gpt-5.5`); a bare `id` matches by exact id across providers. Only authed models are used; a configured model that isn't authed is skipped with a warning. With no panel configured, fusion auto-selects a diverse set spread across providers. The judge defaults to your current model, falling back to the first panel model.

**Reasoning support.** Fusion asks Pi which provider-neutral reasoning levels each model supports. If a requested level is unsupported, that model runs without the requested reasoning and Fusion reports a non-fatal warning; it does not silently substitute another level. Panel reasoning is preserved across every tool-loop turn and forced finalization. Judge reasoning is used only when at least two panel models succeed and synthesis runs. Reasoning can increase latency, token use, and provider cost.

### Panel tools (multi-turn)

By default panel models answer in a single turn with no tools. Enable tools to let each panel model **gather evidence before answering** (read files, grep, search) across multiple internal turns (bounded by `maxToolCalls`), then return its answer. The judge stays tool-free.

- **`readonly`** (`read`, `grep`, `find`, `ls`): safe; no mutation.
- **`all`**: adds `bash`, `edit`, `write`. **Off by default** and requires consent (the `/fusion-setup` picker prompts; non-interactive runs need `"panelToolsConsent": true`). Because several models run concurrently, mutating runs **serialize the panel** so they can't clobber each other's writes. Without consent, `all` downgrades to read-only.

Set tools and Fusion status display in `/fusion-setup` (Config section) or in `fusion.json` (`panelTools`, `maxToolCalls`, `footerDisplay`). These are user configuration only — the invoking model has no tool parameters to override them.

Fusion contributes status through Pi's keyed status API; it does not own or replace the footer. The built-in footer or any third-party footer extension can render Fusion alongside other extension statuses.

> **Note:** enabling panel tools means **file contents (and command output for `all`) are sent to every panel model's provider**. Only enable it where that's acceptable.

## FAQ

**Does fusion run on every prompt?**

No. By default the mode is `available`, so the active model only calls fusion when a task benefits from multiple perspectives. Routine prompts are untouched. Use `/fusion on` to force it on every prompt, or `/fusion off` to disable it for the session.

**Does it cost more tokens / money?**

Yes, when it runs. Each panel model is a separate completion, plus one judge call. This is why it's opt-in per task by default. Tune cost with `maxPanelModels`, `maxPanelOutputTokens`, `maxCompletionTokens`, and the two reasoning settings. Higher reasoning effort can consume more of a provider's budget and increase latency.

**Is my code or prompt sent to other providers?**

The prompt goes to every panel model and the judge, all models you're already authed for. With **panel tools** enabled, file contents (and command output, for `all`) are also sent to every panel model's provider. Tools are off by default; only enable them where that data sharing is acceptable.

**Why didn't fusion run when I asked?**

In `available` mode the model decides. If you want a guaranteed run, use `/fusion <prompt>` for one prompt or `/fusion on` for the session. Forced mode also needs at least one usable panel model, so check `/fusion-status`.

**Why did I get one model's answer with no analysis?**

The judge synthesis only runs when **two or more** panel models succeed. If a single model answers (others failed or weren't authed), its response is returned directly.

**Which models get picked, and why was one skipped?**

Only authed models are used. With no configured panel, fusion auto-selects a diverse set across providers. A configured model that isn't authed is skipped with a warning. See **How models are resolved** above, or run `/fusion-status` to see the active panel and judge.

**Does it work in non-interactive (`-p`) runs?**

Yes. `/fusion-setup` and the stateful `/fusion --panel` form are interactive-only, so configure `defaultPanel` (or legacy panel/judge fields) in `fusion.json`. `/fusion-report --panel <name> <prompt>` works in print mode because it runs Fusion directly. To allow mutating panel tools without an interactive prompt, set `"panelToolsConsent": true`.

**How do I see what the panel and judge actually said?**

`/fusion-report [--panel <name>] <prompt>` runs fusion directly and writes the raw panel/judge diagnostic report into the editor.

## Commands

| Command | What it does |
|---------|--------------|
| `/fusion-setup` | Load a named panel or customize a panel snapshot, judge, reasoning, tools, and Fusion status display (interactive mode only). |
| `/fusion on` \| `available` \| `off` | Set the session mode (aliases: `forced`, `auto`, `disable`). |
| `/fusion` | With no argument, toggle between `available` and `forced`. |
| `/fusion <prompt>` | Force fusion for a single prompt, then answer normally. |
| `/fusion --panel <name> <prompt>` | Use a named panel for this interactive agent run only, then return to the prior selection. |
| `/fusion-status` | Show the current mode, named panel when applicable, panel snapshot, reasoning, judge, tools, and Fusion status verbosity. |
| `/fusion-report [--panel <name>] <prompt>` | Run fusion directly and write the raw panel/judge diagnostic report into the editor; named selection also works in print mode. |
| `/fusion-init` | Write a `.pi/fusion.json` template (confirms before overwriting; trusted projects only). |

### `/fusion-setup` controls

Two sections, **Models** and **Config**, with the live panel/judge selection shown at the top. **Tab** switches sections; **Enter** saves, **Esc** cancels.

- **Models:** `↑/↓` move · `p` toggle panel · `j` toggle judge (independent of the panel; can be any model or left unset for auto) · `c` clear panel · `/` search.
- **Config:** `↑/↓` move · `Space` / `←→` change a value. Settings: **Named panel** (when configured), **Panel reasoning**, **Judge reasoning**, **Panel tools** (`none` → `readonly` → `all`), **Max tool calls** (`4`/`8`/`12`/`16`/`25`/`50`/`100`), and **Fusion status** (`full` → `compact` → `off`).

Selections (panel, judge, reasoning, tools, status display, and mode) are saved as a detached session snapshot and restored on `/resume`. Loading a named panel copies its resolved values; the saved snapshot does not follow later config-file edits.

## Development

```bash
npm install    # installs peer deps for type-checking and tests
npm run check  # tsc --noEmit
npm test       # runs every suite in src/__tests__/
npm pack --dry-run
```

There's no build step. Try the extension live with `pi -e .`, then `/reload` after edits.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and PR guidelines, [SECURITY.md](SECURITY.md) for reporting vulnerabilities, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and the GitHub issue templates.

## Differences from OpenRouter Fusion

- Uses pi's authed models instead of OpenRouter's catalog.
- Does not inject `openrouter:web_search` or `openrouter:web_fetch` into panel/judge calls (pi has its own tools; the outer model can still use them).
- No recursion-depth header is needed; inner calls use `complete()` directly and never see the `fusion` tool.
- Adds named panels and interactive panel/judge/reasoning selection via `/fusion-setup`.
- Adds session modes (`available`, `forced`, `off`), diagnostic reports (`/fusion-report`), and session-state persistence.
