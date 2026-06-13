# pi-thinking-ui: Elegant Thinking Renderer

**Date:** 2026-06-13
**Status:** Design — awaiting user review
**Packages affected:** `packages/coding-agent` (core), `packages/extensions/pi-thinking-ui`
**Supersedes:** current monkey-patch implementation in `pi-thinking-ui/internal-patch.ts`

## Problem

`pi-thinking-ui` is the only one of pi's four extensions that patches pi internals at runtime.
To replace the inline thinking rendering inside assistant message bubbles, it:

- `import.meta.resolve`s internal `dist/` module paths and `await import()`s them (violates
  the repo's "No inline imports" rule, and is inherently fragile across pi versions);
- monkey-patches `AssistantMessageComponent.prototype.updateContent` /
  `setHideThinkingBlock` / `setHiddenThinkingLabel`;
- needs a `markdownTheme as any` cast and a bespoke fallback / reference-counted install-then-
  release machine (`internal-patch.ts`, 440 lines; the fallback + refcount logic in `state.ts`);
- degrades an entire session to pi's native renderer whenever the patch fails, with live mode
  switching disabled.

The root cause is structural: pi's public extension API has **no hook to replace the inline
rendering of an assistant message's thinking blocks**. `registerMessageRenderer` only covers
extension-created `CustomMessage`s; `setWidget`/`setFooter`/`setHeader`/`custom()` target regions
*outside* the message bubble; the `message_*` events are read-only. The hardcoded thinking
rendering lives in `AssistantMessageComponent.updateContent` (`assistant-message.ts:94-118`)
with no injection seam. So an extension cannot do inline thinking rendering *without* patching
internals today.

## Goal

Add a minimal, `registerMessageRenderer`-style hook to core so extensions can replace inline
thinking rendering through a real public API. Then rewrite `pi-thinking-ui` to use it, deleting
all monkey-patching, the `dist/` coupling, the `as any`, and the fallback/refcount machinery.

## Non-goals

- No change to how pi renders text blocks, tool calls, abort/error indicators, or OSC133 zones.
- No change to pi's thinking-*content* parsing, streaming, or storage.
- No new features to `pi-thinking-ui`'s three modes (collapsed/summary/expanded) beyond what
  exists today — this is a "scrap and rebuild on a clean API" refactor, not a feature add.
- No backward compatibility for the current patch-based internals (per AGENTS.md: do not preserve
  backward compatibility unless asked).

## Design

### Phase 1 — Core: thinking renderer hook (`packages/coding-agent`)

**New public API**, mirroring the proven `registerMessageRenderer` wiring (`loader.ts:232` register →
`runner.ts:546` getter → component constructor takes it):

```ts
// core/extensions/types.ts

/** Context passed to a thinking renderer. */
export interface ThinkingRenderContext {
	/** The assistant message currently being rendered. */
	message: AssistantMessage;
	/** All non-empty thinking blocks in this message, in document order. */
	thinkingBlocks: ThinkingContent[];
}

/**
 * Renderer for the inline thinking blocks of an assistant message.
 *
 * Called once per assistant message (not once per block) when there is at least one
 * non-empty thinking block and pi's global "hide thinking" toggle is OFF.
 * - Return a Component: pi uses it in place of the default thinking rendering, placed at the
 *   position of the first thinking block.
 * - Return undefined: pi falls back to its built-in Markdown rendering.
 */
export type ThinkingRenderer = (ctx: ThinkingRenderContext, theme: Theme) => Component | undefined;
```

```ts
// ExtensionAPI (in core/extensions/types.ts), under "Message Rendering":
/** Register a renderer that replaces the inline thinking-block rendering of assistant messages. */
registerThinkingRenderer(renderer: ThinkingRenderer): void;
```

**Implementation touches (all mechanical copies of the existing renderer pattern):**

1. `core/extensions/types.ts` — add `ThinkingRenderer`, `ThinkingRenderContext`, and the
   `registerThinkingRenderer` method on `ExtensionAPI`.
2. `core/extensions/loader.ts` — add an optional `thinkingRenderer` field on the per-extension
   record and implement `registerThinkingRenderer` (copy of `registerMessageRenderer` at `:232`).
3. `core/extensions/runner.ts` — add `getThinkingRenderer(): ThinkingRenderer | undefined`
   (copy of `getMessageRenderer` at `:546`).
4. `modes/interactive/components/assistant-message.ts`:
   - constructor gains an optional `thinkingRenderer?: ThinkingRenderer` param;
   - `updateContent`: when reaching the **first** thinking block, if a renderer is present AND
     `hideThinkingBlock === false`, call it once with `{ message, thinkingBlocks }` (all non-empty
     thinking blocks, pre-collected) and, if it returns a Component, add that component and skip
     the default `Markdown` rendering for every thinking block; otherwise behave exactly as today.
   - The "has visible content after" spacer logic is preserved.
5. `modes/interactive/interactive-mode.ts` — the two `AssistantMessageComponent` construction
   sites (`:2772` streaming, `:3160` history) pass
   `this.session.extensionRunner.getThinkingRenderer()`. (`:3104` already does the equivalent
   `getMessageRenderer(...)` call for custom messages, so the access path is established.)

**Phase 1 is backward-compatible and independently shippable:** with no renderer registered,
behavior is byte-for-byte identical to today. Phase 1 can land before Phase 2 exists.

### Phase 2 — Rewrite `pi-thinking-ui` on the new API

**Entry `index.ts`:** in the factory, register the renderer:

```ts
pi.registerThinkingRenderer((ctx, theme) =>
	new ThinkingUIComponent(theme, ctx.message.timestamp, ctx.thinkingBlocks, resolveThinkingMessageScope(ctx.message)),
);
```

Keep: `/thinking-ui` command, `Alt+T` shortcut, and the `message_start` / `message_update` /
`message_end` / `agent_end` / `session_start` / `session_shutdown` event wiring used for
mode / active-state / message-scope tracking and mode persistence.

**Delete ("scrap this"):**

- **`internal-patch.ts` — entire file (440 lines).** Monkey-patch, `import.meta.resolve`,
  `await import()`, the `markdownTheme as any` cast, the prototype save/restore, and the
  install/fallback logic all disappear.
- **`state.ts`:** delete the patch machinery — `patchReleases*`, `patchRefCount`, `patchCleanup`,
  `patchInstallPromise`, and the `get/set/increment/decrementPatchRefCount`,
  `get/setPatchCleanup`, `get/setPatchInstallPromise`, `register/takeThinkingPatchRelease`
  functions. Delete `LegacyThinkingUIGlobalState` + the legacy-migration body of
  `ensureGlobalStateShape` (AGENTS.md: no backward compat). Keep mode / active /
  message-scope tracking and `Symbol.for` persistence.
- **`index.ts`:** delete the entire "degraded session" apparatus — `degradedSessionScopes`,
  `markSessionDegraded`, `isSessionDegraded`, the `retainThinkingUIPatch()` call, `reportPatchError`,
  and the patch register/release dance in `session_start` / `session_shutdown`.

**Keep as-is:** `parse.ts` (summary engine), `render.ts` (`ThinkingUIComponent`),
`persistence.ts` (preference storage), `types.ts`. `package.json` drops
`internal-patch.ts` from `files`.

**Net effect:** 7 files → 6 files; `internal-patch.ts` → 0 lines; `state.ts` and `index.ts`
slim substantially; zero `dist/` coupling; fully compliant with pi's extension best practices.

## Behavioral change (only one) — intentional

**Today:** `pi-thinking-ui`'s patch renders its custom three-mode UI even when pi's global
"hide thinking" toggle (`hideThinkingBlock`, cycled by a keybinding) is ON — the extension
ignores the hide toggle.

**After:** when `hideThinkingBlock === true`, core does **not** call the renderer and shows the
built-in hidden-thinking label instead — i.e. `pi-thinking-ui` **respects** the global hide toggle.

**Rationale:** this is more consistent. When a user hides thinking, they want it hidden; when
they want a compact view they use the extension's own `collapsed` mode. "Hide" and "thinking-ui's
collapsed mode" stop fighting. (This must be explicitly approved — see Review gate below.)

## Risks

1. **New public API surface on the flagship package.** `packages/coding-agent` gains a permanent
   `registerThinkingRenderer` contract that must be maintained across versions. This is the cost
   chosen when selecting path A; it buys the elimination of internal coupling. Mitigation: the API
   shape mirrors `registerMessageRenderer` exactly, so its maintenance profile is already
   understood by the codebase.
2. **Two construction sites must both be wired** (`interactive-mode.ts:2772` streaming, `:3160`
   history). Missing one would mean the renderer works while streaming but not on session reload
   (or vice versa). Mitigation: Phase 1 verification checks both paths render through the hook.
3. **Behavioral change** above — must be approved.

## Testing

Phase 1 (core):
- No new test files required by repo rules, but `npm run check` (biome + tsgo + pinned-deps +
  ts-imports + shrinkwrap + browser-smoke) must pass.
- Manual smoke: with no extension registering a renderer, a normal session's thinking renders
  identically (visual spot-check in tmux).

Phase 2 (extension):
- `npm run check` passes.
- Manual smoke in tmux: `/thinking-ui collapsed|summary|expanded` cycles modes; `Alt+T` cycles;
  mode persists across reload; with pi's hide-thinking toggle ON, the built-in label shows and
  the custom UI does not.

## Open questions for review

1. Approve the single behavioral change (respecting the global hide-thinking toggle)?
2. Confirm the two-phase order (Phase 1 lands in core first and is independently green before
   Phase 2 rewrites the extension).

Naming (`registerThinkingRenderer` / `ThinkingRenderer` / `ThinkingRenderContext`) is presented as a
recommendation that mirrors `registerMessageRenderer`; change it if you prefer a different name, but
no decision is required to proceed.
