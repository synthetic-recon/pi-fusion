# pi API gaps & workarounds

Notes from a whole-codebase audit (all verified against the installed `@earendil-works/*`
`.d.ts`). These are gaps in **pi's** public API / docs that force workarounds in this extension —
captured here so they aren't re-discovered, and as candidates to file upstream. The workarounds are
intentional; each carries a matching `// pi gap:` comment at its call site.

## Missing public APIs

- **`SelectList` has no public `setItems()`.** `items`/`filteredItems` are `private`
  (`pi-tui/dist/components/select-list.d.ts:27-28`) and the only public mutator, `setFilter`, just
  prefix-matches on `value`. To re-render the list after a panel/judge toggle or a multi-field
  search, `src/ui.ts` (`setSelectListItems`) writes those private arrays — guarded by a runtime
  shape assertion so a future pi-tui rename fails loudly instead of silently. A public
  `SelectList.setItems(items: SelectItem[])` would remove the workaround.

- **`Model<Api>.compat` types as `never` for the generic `Api`.** `supportsTemperature` lives only
  on `AnthropicMessagesCompat` (`pi-ai/dist/types.d.ts:393`), and `Model<Api>.compat` resolves to
  `never` for the generic `Api`. `src/llm.ts` (`getSupportsTemperature`) narrows on the `model.api`
  discriminant and reads it through a *precise* `Model<"anthropic-messages">` cast (no `as any`).
  TS narrows the value, not the type parameter, so one precise cast remains; a
  `modelSupportsTemperature(model)` export in `pi-ai` would remove even that.

- **OpenAI Responses metadata cannot express temperature support.** The exact
  `github-copilot/gpt-5.6-sol` model rejects `temperature`, but Pi's OpenAI Responses model
  metadata has no equivalent to Anthropic's `supportsTemperature` capability. `src/llm.ts`
  (`getSupportsTemperature`) therefore excludes only that canonical provider/model pair; other
  GitHub Copilot and `gpt-5.6-sol` combinations remain unchanged. An OpenAI Responses-compatible
  temperature-support capability in `pi-ai`, populated as unsupported for this exact pair, would
  remove the workaround.

> Resolved (no longer a gap): an earlier `withSignal` Proxy over `ExtensionContext` was removed —
> every built-in tool honors the explicit `signal` argument passed to `execute`, and pi-fusion has
> no separate per-panel signal, so the Proxy was redundant.

## Used but documented only in `.d.ts` (not in `docs/*.md`)

These work fine but are undocumented; relying on them is a small risk:
- `getSelectListTheme()` (only `getSettingsListTheme` is in `docs/tui.md`).
- `ModelRegistry.isUsingOAuth(model)` and `getAvailable()`.
- The tool-definition factories (`createReadToolDefinition` etc.) and the `AgentToolResult` shape
  used by panel tool loops.
