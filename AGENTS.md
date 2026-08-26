# AGENTS.md

Guidance for AI agents working in **pi-fusion** — a [pi](https://github.com/earendil-works)
extension that runs a prompt against a panel of authed models in parallel, then has a judge model
return structured analysis (consensus / contradictions / partial coverage / unique insights /
blind spots). See `README.md` for user-facing behavior and `docs/proposals/` for design intent.

## Commands

- `npm run check` — type-check (`tsc --noEmit`). **There is no build step**: pi loads the TypeScript
  directly via [jiti](https://github.com/unjs/jiti). `npm run build` is intentionally a no-op echo.
- `npm test` — runs every `src/__tests__/*.test.ts`. The runner is a tiny custom harness
  (`src/__tests__/_harness.ts` exports `test`/`eq`/`fakeModel`); there is no jest/vitest.
- Run a single suite: `node --import jiti/register src/__tests__/<name>.test.ts`.
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` — stricter pass; catches dead
  imports/locals that `npm run check` won't. Run it before finishing a change.
- `npm pack --dry-run` — verify the published tarball (the `files` glob is `src/*.ts` + docs; it is
  **non-recursive**, so `src/__tests__/` and `docs/` are correctly excluded).
- Try it live in pi: `pi -e .` (or `pi install /abs/path`), then `/reload` after edits.
- **Requires Node ≥ 22.19.0** (the `@earendil-works/pi-*` peers need it; built-in tools load
  undici 8). CI runs Node 22.

## Architecture (the parts that span files)

**Extension shape.** `src/index.ts` `export default function (pi: ExtensionAPI)` is the entry point.
It registers the `fusion` tool, the `/fusion*` commands, and lifecycle handlers (`input`,
`tool_call`, `session_start`/`session_tree`/`model_select`). Everything is wired against pi's peer
packages — `@earendil-works/pi-ai` (`complete`, model/message types), `pi-coding-agent`
(`ExtensionAPI`/`ExtensionContext`, `ModelRegistry`, tool factories), `pi-tui` (TUI components),
and `typebox` (tool param schemas). **Verify any pi API against its installed `.d.ts` before
using it** — much of it is typed-only and not in the written docs.

**The pipeline** (`src/fusion.ts` `runFusion`): resolve panel + judge (`models.ts`
`resolvePanelAndJudge`) → run the panel concurrently (`utils.ts` `mapWithConcurrencyLimit`,
`PANEL_CONCURRENCY`) through `llm.ts` (`callModelText`, or `callModelWithTools` when panel tools are
enabled) → if ≥2 panelists succeed, the judge produces a JSON analysis parsed by `utils.extractJson`
→ assembled into `FusionDetails` (`types.ts`). Partial failure degrades gracefully (single success
skips the judge; all-failed is classified). `format.ts` renders the diagnostic report for
`/fusion-report`.

**Config + precedence.** `config.ts` `loadConfig` reads project `.pi/fusion.json` (trusted projects
only) then global `~/.pi/agent/fusion.json`; `applyDefaults` fills every numeric knob and returns a
`ResolvedFusionConfig` (so callers read `config.*` directly, not `?? DEFAULT`). **Panel/judge are
always user configuration** — the `fusion` tool deliberately exposes no `analysis_models`/`model`
params, so the invoking model can't pick them. Effective precedence: session selection
(`/fusion-setup`) → `fusion.json` → auto-diverse selection.

**Session state.** There is no key/value store: state is appended as custom session entries via
`pi.appendEntry("fusion-state", …)` and read back by scanning `ctx.sessionManager.getBranch()`
(`restoreSessionState`). The footer, `/fusion-status`, `/fusion on`, forced input, and session options derive from `effectivePanel`
(session → falls back to `fusion.json`). Modes (`available`/`forced`/`off`) live in that state.

**Panel tools (multi-turn).** `tools.ts` builds tool definitions only from pi's hard-coded
`create*ToolDefinition` factories (an allowlist) — this is the recursion guarantee: the `fusion`
tool can never leak into a panel's tool list. `llm.ts` `callModelWithTools` runs the bounded loop
(cap, repeat/error circuit breaker, output truncation via `utils.truncateToBytes`). Mutating tools
(`bash`/`edit`/`write`) are off by default, require consent, and serialize the panel.

**Setup UI.** `src/ui.ts` `selectFusionSetup` is a custom `ctx.ui.custom` TUI: a two-section
(models `SelectList` + config) screen with independent panel (`p`) and judge (`j`) toggles. The
pure selection helpers (`togglePanelMember`, `toggleJudgeSelection`, `modelBadges`) are exported and
unit-tested; the TUI rendering is not.

## Conventions & gotchas

- **Documented pi-API workarounds live in `docs/pi-api-notes.md`** and carry `// pi gap:` comments
  at each site (e.g. `setSelectListItems` writes SelectList's private arrays behind a loud guard;
  `getSupportsTemperature` narrows via the `model.api` discriminant with a precise — not `any` —
  cast). Don't "clean these up" without reading that file; some are unavoidable until pi adds APIs.
- **Releases are automated.** Bump `package.json`/`package-lock.json`, add a `## X.Y.Z` section to
  `CHANGELOG.md`, then push the `vX.Y.Z` tag — `.github/workflows/release.yml` runs check+test,
  publishes to npm (OIDC trusted publishing, no token), and creates a GitHub Release from that
  CHANGELOG section. **The heading must be exactly `## X.Y.Z` to match the `vX.Y.Z` tag**, or the
  extractor falls back to auto-generated notes.
- Match the surrounding style (tabs, no semicolon-free experiments); keep the package dependency-free
  (`dependencies: {}` — pi packages are peers).
