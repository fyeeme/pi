# Changelog

## [Unreleased]

### Added
- Initial release: `/mermaid` command to render Mermaid diagrams from the conversation in the browser.
- Supports dark, light, and white backgrounds.
- Zoom controls and 2x PNG export.
- Split view to see source code alongside rendered diagram.
- Emoji and special-character sanitization for Mermaid compatibility.
- Auto-quoting node labels containing `?`, `@`, `<`, `>`, `/`, `&`, `#`, `!` (and `(){}[]`) across all common shapes: rectangle, rhombus, rounded, circle, hexagon, subroutine, cylinder, parallelogram. Fixes parse errors like `B{注解?<br/>@Transactional}`.
- Emoji support: emoji are now preserved and rendered natively (previously stripped). Verified with Mermaid v11 + `securityLevel: "loose"` + `htmlLabels: true`. Emoji are kept on screen but stripped from SVG/PNG exports for portability.
- Multi-diagram navigation when conversation contains multiple blocks.
