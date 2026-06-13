# pi-thinking-ui: Elegant Streaming Panel (third-party compliant)

**Date:** 2026-06-13
**Status:** Design — awaiting user review
**Package affected:** `packages/extensions/pi-thinking-ui` (core untouched)
**Supersedes:** current monkey-patch implementation in `pi-thinking-ui/internal-patch.ts`

## Hard constraint (changed from earlier draft)

We are a **third-party extension author**. We **cannot modify `packages/coding-agent`**.

This invalidates the earlier "Phase 1: add a thinking renderer hook to core" design. The inline
thinking rendering is hardcoded in `AssistantMessageComponent.updateContent`
(`assistant-message.ts:94-118`) with no injection seam, and core exposes no API to replace it. A
third party therefore **cannot** replace inline thinking rendering without monkey-patching core
internals.

Decision: **stop monkey-patching.** Render the three-mode thinking UI as a widget, using only pi's
public extension API. Accept the resulting UX change.

## Problem (third-party framing)

`pi-thinking-ui` is the only pi extension that patches pi internals. It `import.meta.resolve`s
internal `dist/` module paths, monkey-patches `AssistantMessageComponent.prototype`, needs a
`markdownTheme as any` cast, and carries a bespoke install/fallback/reference-count machine
(`internal-patch.ts`, 440 lines). This is maximally fragile for a third party: any pi patch release
that moves a `dist/` path or renames a prototype method breaks the extension.

## Goal

Rebuild `pi-thinking-ui` on **only public extension API**, so it has zero coupling to pi internals,
zero `dist/` resolution, zero `as any`, and no session-degradation machine. Keep all existing
user-facing features: collapsed/summary/expanded modes, `/thinking-ui` command, `Alt+T` shortcut,
and project/global preference persistence.

## UX change (intentional, the cost of third-party compliance)

- **Before:** the three-mode thinking UI renders **inline**, replacing the thinking block inside
  each assistant message bubble.
- **After:** the three-mode thinking UI renders as a **widget above the editor** (between the
  message list and the input box), tracking **only the currently-streaming assistant message**.

Rationale: there is no public API to render inline, so inline is not available to a third party.
`setWidget(placement: "aboveEditor")` is pi's intended public surface for extension-rendered UI,
and it is the natural home for a live thinking panel.

This is the single substantive behavior change; everything else is preserved.

## "Track only the currently-streaming message"

The widget shows thinking for exactly one message at a time — the assistant message currently
being streamed. Concretely:

- On `agent_start`: the widget is armed (next assistant message becomes the tracked message).
- On `message_update` (assistant) with `thinking_start` / `thinking_delta`: accumulate thinking
  text for the tracked message and render the widget. `thinking_delta` already carries incremental
  text, so we build `ThinkingSourceBlock[]` incrementally.
- On `message_update` (assistant) with non-thinking events (`text_*`, `toolcall_*`,
  `thinking_end`): update active-step state, but keep tracking the same message.
- On `agent_end`: stop tracking. **Clear the widget** (the finished thinking is already persisted
  in the session and remains inline in pi's native bubble — the panel's job is live-only).

This avoids the "which historical message?" complexity entirely. No click-to-inspect, no
last-message fallback — the panel is a live view, by design.

## Non-goals

- No change to pi's inline/native thinking rendering (core is untouched).
- No click-to-inspect historical thinking, no multi-message panel.
- No new modes; collapsed/summary/expanded are preserved as-is.
- No backward compatibility for the current patch internals (AGENTS.md: do not preserve backward
  compat unless asked).
- Not generalized for reuse by other extensions (single consumer today; YAGNI).

## Design

### Architecture

```
pi events ──► index.ts (orchestration)
                 │
                 ├─ agent_start    → arm tracking, clear panel
                 ├─ message_update → accumulate blocks, setWidget(panel)
                 └─ agent_end      → clear panel, disarm

index.ts ──► render.ts: ThinkingUIComponent(theme, timestamp, blocks, scope)
                 │           ↑ built & rebuilt on each thinking_delta
                 │
                 ├─ parse.ts: deriveThinkingUI(blocks) → steps (unchanged)
                 └─ state.ts: mode / active / scope tracking (slimmed)
```

The widget is rebuilt (or its blocks updated) on each `thinking_delta`. Modes/active-state/scope
live in `state.ts` (slimmed), so mode switches via `/thinking-ui` and `Alt+T` re-render live.

### File-level changes

**Delete (the "scrap this" core):**
- **`internal-patch.ts` — entire file (440 lines).** No more `dist/` resolution, prototype patching,
  `as any`, fallback, or ref-counted install/release.

**`index.ts` (rewrite orchestration):**
- Remove all patch machinery: `retainThinkingUIPatch`, `degradedSessionScopes`,
  `markSessionDegraded`, `isSessionDegraded`, `reportPatchError`, the patch register/release in
  `session_start` / `session_shutdown`.
- New streaming-tracked widget logic in `agent_start` / `message_update` / `agent_end` (as above).
- Keep: `/thinking-ui` command, `Alt+T` shortcut, mode persistence, scope tracking.
- Register the widget via `ctx.ui.setWidget("thinking-ui", factory, { placement: "aboveEditor" })`
  while streaming, and `setWidget("thinking-ui", undefined)` on `agent_end`.

**`render.ts`:**
- `ThinkingUIComponent` mostly reused (it already implements `Component`). Add a thin
  `updateBlocks(blocks)` method (or rebuild) so incremental `thinking_delta` updates don't
  re-derive from scratch unnecessarily. Add a **theme adapter**: `setWidget`'s factory passes core
  `Theme`, but the component wants `ThinkingThemeLike` — convert once.

**`state.ts`:**
- Delete the patch machinery: `patchReleases*`, `patchRefCount`, `patchCleanup`,
  `patchInstallPromise`, and their accessors (`get/set/increment/decrementPatchRefCount`,
  `get/setPatchCleanup`, `get/setPatchInstallPromise`, `register/takeThinkingPatchRelease`).
- Delete `LegacyThinkingUIGlobalState` + legacy migration (no backward compat).
- Keep mode / active / message-scope tracking and `Symbol.for` persistence.

**Keep unchanged:** `parse.ts` (summary engine), `persistence.ts` (preference storage), `types.ts`.

**`package.json`:** drop `internal-patch.ts` from `files`. (README still missing from `files`
already removed in the prior audit pass.)

### Event flow detail

The tracked-message state lives in module scope of `index.ts` (one active message at a time):

- `trackedMessage: { timestamp: number; blocks: ThinkingSourceBlock[] } | undefined`
- `agent_start` → set a `tracking = true` flag (no widget yet; nothing to show until thinking
  arrives). Clear any stale tracked message.
- `message_update` (assistant, `thinking_start`/`thinking_delta`) → if `tracking`, set
  `trackedMessage` from `event.message` (id by timestamp), accumulate blocks, `setWidget(...)`.
- `message_update` (assistant, other types) → update active state in `state.ts` so the panel shows
  the right active step; keep widget.
- `agent_end` → `setWidget("thinking-ui", undefined)` to clear; `trackedMessage = undefined`;
  `tracking = false`.

If a message streams with no thinking at all, no widget is shown (nothing to render).

### Theme adapter

`setWidget` factory signature: `(tui: TUI, theme: Theme) => Component`. `ThinkingUIComponent`
takes `ThinkingThemeLike`. We add `themeToThinkingLike(theme: Theme): ThinkingThemeLike` in
`render.ts`, mapping the subset of theme methods the component uses (`fg`, `bold`, `italic`, and
the role colors). This keeps `parse.ts`/`render.ts` decoupled from core `Theme`.

## Risks

1. **UX change** (inline → above-editor panel) is the headline cost. Already approved in principle;
   confirmed in spec review.
2. **Theme adapter correctness** — if `ThinkingThemeLike` requires theme methods that core `Theme`
   exposes under different names, the mapping needs care. Mitigation: `render.ts` is read in full
   during implementation; the adapter maps exactly the methods `ThinkingUIComponent` calls.
3. **Incremental updates** — rebuilding the component on every `thinking_delta` could thrash. The
   existing render cache (`cacheKey` in `ThinkingUIComponent`) already guards against redundant
   re-renders; `updateBlocks` just invalidates the cache and re-derives steps.
4. **Empty-thinking messages** produce no widget (correct, but worth a smoke check).

## Testing

- `npm run check` passes (biome + tsgo + pinned-deps + ts-imports + shrinkwrap + browser-smoke).
- Manual smoke in tmux:
  - `/thinking-ui collapsed|summary|expanded` switches mode, panel re-renders live.
  - `Alt+T` cycles modes.
  - During streaming, panel shows current message's thinking; on `agent_end`, panel clears.
  - Message with no thinking → no panel.
  - Mode preference persists across session reload.

## Open questions for review

1. Confirm "clear the panel on `agent_end`" (live-only) vs "keep last message's thinking visible
   until the next stream". Default: clear (thinking remains inline in pi's native bubble after
   completion, so the panel's job is done).
