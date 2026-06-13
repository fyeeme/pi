# pi-thinking-ui: Hardened Monkey-Patch (C2)

**Date:** 2026-06-13
**Status:** Final — this is the shipped approach
**Package affected:** `packages/extensions/pi-thinking-ui`

## Context: how we got here

The original request was to "scrap this and implement the elegant solution" for `pi-thinking-ui`.
Three rounds of analysis converged on an unavoidable constraint triangle:

| Goal | A: core hook | B: pure-API panel | C: keep patch |
|---|---|---|---|
| Scrap the monkey-patch | ✅ | ✅ | ❌ |
| UX not degraded (inline) | ✅ | ❌ (panel) | ✅ |
| Works against upstream pi (no upstream PR) | ❌ | ✅ | ✅ |

- **A** (add `registerThinkingRenderer` to `packages/coding-agent`) requires the upstream pi to ship
  the hook. Since `pi-thinking-ui` is published as a standalone package consumed against the
  **upstream** `@earendil-works/pi-coding-agent`, and upstream won't merge that PR, the hook is
  unreachable for downstream users. A is out.
- **B** (subscribe to `message_update`, render via `setWidget(aboveEditor)`) is pure-API and clean,
  but degrades UX: thinking moves out of the message bubble into a separate panel. Rejected by the
  "UX not degraded" constraint.
- **C** (keep the monkey-patch) is the only path that satisfies the two hard constraints
  ("inline UX preserved" + "works against upstream pi"). The patch is unavoidable because the
  inline thinking rendering lives in `AssistantMessageComponent.updateContent`
  (`assistant-message.ts:94-118`) with **no public injection seam** in upstream pi.

**Decision: C.** Specifically C2 — keep the patch architecture, but harden everything that has
genuine net benefit. Do not harden further once marginal benefit hits zero.

## What "hardening" means here (and what it does not)

The patch's core components — `dist/` resolution, prototype override, fallback machine, reference
counting, import-structure assertions — are **load-bearing**, not redundant:

- **3 patched methods (`updateContent` / `setHideThinkingBlock` / `setHiddenThinkingLabel`)** — each
  is a feature (thinking rendering, hide-toggle override, label-driven refresh), not duplication.
  Removing any degrades behavior.
- **`withOriginalInstanceMethods` + fallback functions (~90 lines)** — the only safety net. When the
  patched render throws, this restores the original method on the instance and calls it, so the user
  still sees content instead of a blank bubble. Removing this turns a recoverable patch failure into
  a blank screen.
- **Reference counting (`retainThinkingUIPatch` + `state.ts` refcount)** — the patch overrides the
  **global** `AssistantMessageComponent.prototype`, shared by all sessions in one process. pi supports
  `switchSession` / `reload`, which fire `session_shutdown` + `session_start` within one process.
  Refcounting ensures the global patch is installed once and removed only when the last session
  exits. Simplifying to "install once, never remove" leaks patches across reloads and risks
  double-install. Keep.
- **`assertPatchableAssistantMessageComponent` / `assertThinkingUITheme`** — turn a future upstream
  rename/move into a clear "incompatible" error instead of a cryptic `undefined is not a function`.
  The more fragile the patch, the more these earn their keep. Keep.

**Principle:** stop where the next change trades real robustness for line count. That point is
reached.

## What was actually changed (this is the entirety of the hardening)

| File | Change | Why it has net benefit |
|---|---|---|
| `internal-patch.ts:296` | `this.markdownTheme as any` → typed via imported `MarkdownTheme` (interface field `unknown` → `MarkdownTheme`) | Removes `any` (AGENTS.md violation). `MarkdownTheme` is already a public `@earendil-works/pi-tui` export; no guessing. |
| `parse.ts` | Deleted dead `firstMeaningfulLine` / `firstSentence` (zero call sites, unexported) | Pure dead code. |
| `render.ts` | Deleted dead `stepHeader` / `stripInlineFormattingMarkers` (zero call sites) | Pure dead code. |
| `state.ts` | Deleted write-only `patchReleases` field (and its legacy-migration computation) | Only `patchReleasesByScope` is read; `patchReleases` was never read by any consumer. |
| `package.json` | Removed non-existent `README.md` from `files` | Other 3 sibling extensions ship a real README; this one doesn't. Avoids `npm pack` warning and manifest/contents mismatch. |
| `index.ts` | Inlined 4 single-line single-call-site helpers | AGENTS.md: inline single-line helpers with one call site. |

## What is deliberately NOT changed

- Patch architecture (dist resolution, prototype override, fallback, refcount, assertions) — see
  "load-bearing" above.
- The one known behavioral quirk: the patch ignores pi's global hide-thinking toggle
  (`hideThinkingBlock`). This is intentional behavior of the current implementation, not a defect to
  fix under C2 (C2 = preserve behavior, harden code). Changing it would be a behavioral change
  belonging to a different decision.

## Verification

- `npm run check` passes (biome + tsgo + pinned-deps + ts-imports + shrinkwrap + browser-smoke).
- Package-level `tsc` passes.
- No behavioral change intended; the changes are type-safety + dead-code removal only.

## Open question (informational, not blocking)

The earlier audit flagged the `state.ts` legacy-migration code (`LegacyThinkingUIGlobalState` +
`ensureGlobalStateShape` ~80 lines) as backwards-compat code that AGENTS.md says not to keep. It was
**not** removed in the hardening pass because it guards against on-disk state-shape drift across pi
versions (runtime robustness), which is a different concern than API/SDK backward compatibility.
Removing it is a separate decision and carries a real (if small) risk for users with old state
files. Left as-is under C2; revisit if desired.
