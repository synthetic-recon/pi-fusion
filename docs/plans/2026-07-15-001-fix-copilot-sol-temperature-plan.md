---
title: "Copilot Sol Temperature Compatibility - Plan"
type: "fix"
date: "2026-07-15"
artifact_contract: "ce-unified-plan/v1"
artifact_readiness: "implementation-ready"
product_contract_source: "ce-plan-bootstrap"
execution: "code"
origin: "https://github.com/synthetic-recon/pi-fusion/issues/16"
---

# Copilot Sol Temperature Compatibility - Plan

## Goal Capsule

| Field | Value |
|---|---|
| Objective | Prevent `github-copilot/gpt-5.6-sol` from receiving the unsupported `temperature` request field while preserving temperature behavior for every other model. |
| Source of truth | GitHub issue #16, the confirmed request path in `src/fusion.ts` and `src/llm.ts`, and Pi's OpenAI Responses model metadata and serializer behavior. |
| Execution profile | Localized compatibility fix implemented test-first at the shared completion-options boundary. |
| Stop conditions | Reassess before coding if the installed Pi peer exposes authoritative temperature capability metadata for OpenAI Responses models or if reproducing the regression requires broader matching than the confirmed provider/model pair. |
| Tail ownership | Implementation owns the focused code, regression tests, documentation update, and repository verification; release work is separate. |

---

## Product Contract

### Summary

This plan adds an exact compatibility exception for `github-copilot/gpt-5.6-sol`, preventing Pi's OpenAI Responses adapter from serializing the configured temperature for that model while leaving every neighboring provider and model unchanged.

### Problem Frame

pi-fusion resolves one user-controlled temperature and passes it to panel, tool-loop, and judge completions.
`buildCompleteOptions()` attaches that value unless `getSupportsTemperature()` identifies a known incompatibility.
The helper understands Anthropic's typed metadata and a Codex naming heuristic, but Pi exposes no equivalent OpenAI Responses capability for `github-copilot/gpt-5.6-sol`.
The options object therefore contains `temperature: 0.3`, Pi serializes it, and the GitHub Copilot endpoint rejects the request with an unsupported-parameter error.

### Requirements

**Compatibility behavior**

- R1. `github-copilot/gpt-5.6-sol` omits the `temperature` property from completion options for panel, tool-loop, forced-finalization, and judge calls.
- R2. The existing configured temperature value and precedence remain unchanged for all other models.
- R3. The compatibility decision uses exact provider and model ID equality, without provider-wide, API-wide, reasoning-wide, alias, substring, or model-family suppression.

**Change boundaries**

- R4. The fix remains inside the shared LLM request-options seam and does not add configuration, warnings, retries, dependencies, or command-specific behavior.
- R5. The Pi API workaround documentation records the exact exception, why metadata cannot express it today, and the condition for removing the workaround.

### Acceptance Examples

- AE1. Given `github-copilot/gpt-5.6-sol` and a configured temperature of `0.3`, when completion options are built, then the options object has no `temperature` property.
- AE2. Given another GitHub Copilot OpenAI Responses model and a configured temperature of `0.3`, when completion options are built, then the options object retains `temperature: 0.3`.
- AE3. Given `gpt-5.6-sol` under a provider other than GitHub Copilot and a configured temperature of `0.3`, when completion options are built, then the options object retains `temperature: 0.3`.
- AE4. Given the affected model is used as either a panelist or judge, when fusion constructs the request, then both paths apply the same compatibility decision through the shared options builder.

### Scope Boundaries

- The active change is limited to `src/llm.ts`, `src/__tests__/llm.test.ts`, and `docs/pi-api-notes.md`.
- It does not alter `fusion.json`, the default temperature, model resolution, fusion failure policy, reporting, setup UI, or command routing.
- It does not update Pi peer dependencies, patch Pi's provider implementation, generalize capability detection, or add aliases for future models.

#### Deferred to Follow-Up Work

- Replace local model heuristics with provider-neutral Pi capability metadata if Pi later exposes an authoritative `modelSupportsTemperature(model)`-style API.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Match only the canonical provider/model pair. (session-settled: user-approved — chosen over provider-wide or model-family suppression: only the reported provider/model pair is evidenced to reject temperature.)
- KTD2. Apply the exception in `getSupportsTemperature()` and retain `buildCompleteOptions()` as the single enforcement seam.
  This covers plain panel calls, all tool-loop turns, forced finalization, and judge synthesis without duplicating logic in `src/fusion.ts`.
- KTD3. Prove both omission and non-target preservation at the outgoing options boundary.
  A three-case identity matrix prevents a future edit from broadening the workaround silently.
- KTD4. Keep the workaround paired with a `// pi gap:` comment and `docs/pi-api-notes.md` entry.
  Repository conventions treat these markers as intentional compatibility contracts that must remain visible until upstream support replaces them.

### Sequencing

Add the failing request-options regression first, implement the exact predicate, add the two negative controls, then synchronize the Pi-gap documentation before running repository-wide checks.

### Risks & Dependencies

- The checkout uses Pi peer packages `0.79.3`, while issue #16 reports Pi `0.80.6`; the affected model is absent from the local generated catalog, so deterministic `fakeModel()` coverage is the reliable local proof.
- Pi model metadata is evolving quickly.
  The implementer must verify the installed declarations before retaining the workaround, but must not broaden scope into a dependency upgrade.
- A broad Copilot or model-name rule would silently remove user configuration from models that may support temperature.
  The negative controls are required protection against that regression.

### Sources & Research

- GitHub issue #16 supplies the affected versions, configuration, reproduction command, and provider error.
- `src/fusion.ts` passes the same resolved temperature into plain panel, tool-loop, and judge calls.
- `src/llm.ts` centralizes completion option construction and existing Anthropic/Codex compatibility rules.
- `src/__tests__/llm.test.ts` owns provider/model request compatibility and already tests the predicate plus `buildCompleteOptions()`.
- `docs/pi-api-notes.md` defines the repository's contract for documenting Pi gaps and their local workarounds.
- Pi's current GitHub Copilot model entry identifies `gpt-5.6-sol` as `openai-responses` without a temperature capability flag, while the OpenAI Responses adapter serializes any supplied temperature.
- No duplicate pi-fusion issue or open pull request was found, and the repository has no `docs/solutions/` learning corpus to inherit.

---

## Implementation Units

### U1. Guard the exact Copilot model at the request-options boundary

- **Goal:** Omit temperature for `github-copilot/gpt-5.6-sol` without changing any other model's completion options.
- **Requirements:** R1, R2, R3, R4, AE1, AE2, AE3, AE4, KTD1, KTD2, KTD3
- **Dependencies:** None
- **Files:** `src/llm.ts`, `src/__tests__/llm.test.ts`
- **Approach:** Extend the existing compatibility predicate with exact provider and model ID equality, preserving the typed Anthropic metadata path and Codex heuristic unchanged.
- **Execution note:** Start with a failing `buildCompleteOptions()` regression that proves the target options object contains no temperature, then add the narrow implementation and negative controls.
- **Patterns to follow:** Reuse `fakeModel()` and the custom `test`/`eq` harness in `src/__tests__/llm.test.ts`; keep the workaround beside the existing `// pi gap:` compatibility logic.
- **Test scenarios:**
  - Covers AE1. Build options for `github-copilot/gpt-5.6-sol` with OpenAI Responses metadata and temperature `0.3`; assert that the `temperature` property is absent.
  - Covers AE2. Build or inspect compatibility for a neighboring GitHub Copilot OpenAI Responses model; assert that temperature remains supported and is forwarded.
  - Covers AE3. Inspect compatibility for `gpt-5.6-sol` under a different provider; assert that temperature remains supported.
  - Preserve the existing OpenAI Codex exclusion, Anthropic `supportsTemperature: false` handling, and ordinary OpenAI-compatible inclusion tests.
- **Verification:** The focused LLM suite fails on the current implementation for the exact target, passes after the predicate change, and proves both negative controls.

### U2. Document the OpenAI Responses temperature gap

- **Goal:** Keep the local workaround discoverable and removable when upstream capability metadata becomes available.
- **Requirements:** R5, KTD4
- **Dependencies:** U1
- **Files:** `src/llm.ts`, `docs/pi-api-notes.md`
- **Approach:** Update the adjacent Pi-gap comment and documentation to cover the exact GitHub Copilot exception, the lack of OpenAI Responses temperature metadata, and the desired upstream replacement.
- **Patterns to follow:** Match the existing documentation structure that pairs every workaround with a named source location and a concrete upstream API that would eliminate it.
- **Test scenarios:** Test expectation: none — this unit documents the already-tested compatibility behavior and adds no separate runtime behavior.
- **Verification:** The comment and documentation describe the same exact provider/model boundary and do not imply a broader unsupported-model family.

---

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Focused regression | `node --import jiti/register src/__tests__/llm.test.ts` | The affected options omit temperature and the two identity-boundary controls preserve it. |
| Full behavior suite | `npm test` | No regression across fusion orchestration, configuration, tools, UI, or formatting. |
| Type contract | `npm run check` | The compatibility predicate and fixtures remain valid against installed Pi declarations. |
| Strict dead-code pass | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` | No unused imports, helpers, or parameters were introduced. |
| Package surface | `npm pack --dry-run` | The publishable package remains dependency-free and contains the expected source and documentation files. |

An authenticated smoke using issue #16's reproduction on Pi `0.80.6` or newer is useful supporting evidence when that environment is available, but it is not a local gate because this checkout lacks the affected generated model and a live request calls an external provider.

---

## Definition of Done

- U1 proves that the exact GitHub Copilot model omits temperature and that both provider and model-ID neighbors retain existing behavior.
- U2 keeps the code comment and Pi API notes synchronized with the exact workaround and its removal condition.
- No configuration, UI, model-resolution, failure-policy, dependency, or release changes enter the diff.
- Every gate in the Verification Contract passes.
- Abandoned experimental code and broadened heuristics are absent from the final diff.
- The eventual pull request references issue #16 and explains why the workaround is intentionally narrow.
