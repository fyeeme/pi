# pi-mermaid-viewer

Render Mermaid diagrams found in the conversation as an HTML page opened in the default browser.

## Install

```bash
pi install npm:pi-mermaid-viewer
```

Or project-local:

```bash
pi install -l npm:pi-mermaid-viewer
```

## Usage

Run `/mermaid` to collect all ````mermaid` code blocks from the conversation and open them in your browser.

### Features

- **Dark / Light / White** background themes
- **Zoom** controls (25% – 400%) with 1:1 reset
- **2x PNG export** for sharing
- **Split view** to inspect source alongside rendered diagram
- **Multi-diagram navigation** when the conversation contains multiple blocks
- **Emoji support** — emoji render natively via the browser's color font
- **Auto-quoting** of node labels with special characters (`?`, `@`, `<br/>`, `/`, etc.) that Mermaid cannot parse
- Opens immediately in your default browser — no local server required
