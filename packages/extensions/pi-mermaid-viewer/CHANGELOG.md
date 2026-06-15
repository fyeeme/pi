# Changelog

## [Unreleased]

### Fixed
- **PNG export silently failed** (download never triggered). Root cause: the `EMOJI_RE` regex was authored inline inside the `renderHtml` template literal, whose backslash-eating corrupted `/[\p{Emoji...}]/gu` into `/[p{Emoji...}]/gu`. As a character class that matches the literal letters p/E/m/o/j/i/..., it stripped ~45% of every exported SVG, so the `<img>` used to rasterize failed to load (`onerror`), `img.onload` never fired, and PNG export hung forever. SVG export was unaffected (it serves the blob directly). Fixed by authoring the regex source at module scope and injecting it.

### Changed
- **Try-first / fix-on-failure rendering.** Source is now passed to Mermaid verbatim; the bare-label healer (`quoteBareLabels`) runs *only* if Mermaid rejects the original, then retries once. This makes it structurally impossible to corrupt valid source. The previous up-front `sanitize()` re-wrapped already-correct `subgraph ID["…()"]` lines in extra quotes, causing guaranteed parse errors on method names containing `()`.
- The healer now correctly skips the canonical `subgraph ID[...]` form (not just `subgraph [...]` / `subgraph "..."`).
- Healed source is surfaced in the split view / copy when a fix succeeds; the notice reads "Auto-fixed" instead of "Sanitized".

### Added
- Initial release: `/mermaid` command to render Mermaid diagrams from the conversation in the browser.
- Supports dark, light, and white backgrounds.
- Zoom controls and 2x PNG export.
- Split view to see source code alongside rendered diagram.
- Emoji and special-character sanitization for Mermaid compatibility.
- Auto-quoting node labels containing `?`, `@`, `<`, `>`, `/`, `&`, `#`, `!` (and `(){}[]`) across all common shapes: rectangle, rhombus, rounded, circle, hexagon, subroutine, cylinder, parallelogram. Fixes parse errors like `B{注解?<br/>@Transactional}`.
- Emoji support: emoji are now preserved and rendered natively (previously stripped). Verified with Mermaid v11 + `securityLevel: "loose"` + `htmlLabels: true`. Emoji are kept on screen but stripped from SVG/PNG exports for portability.
- Multi-diagram navigation when conversation contains multiple blocks.
