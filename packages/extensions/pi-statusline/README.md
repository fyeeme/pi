# pi-statusline

A rich custom status bar for [pi](https://pi.dev) that replaces the default footer.

## Features

- **Token usage**: input, output, cache read/write, total per session
- **Cost**: cumulative cost with currency auto-detection (¥ for DeepSeek, $ otherwise)
- **DeepSeek balance**: live account balance fetched on startup and cached for 5 minutes
- **Context window**: usage percentage and size
- **Timing**: elapsed time + tokens/sec for last response
- **MCP status**: connected server count and total tool count
- **Git branch**: current branch shown in cwd display

## Install

```bash
pi install npm:pi-statusline
```

Or project-local:

```bash
pi install -l npm:pi-statusline
```

## Commands

| Command | Description |
|---|---|
| `/balance` | Force refresh DeepSeek account balance |
| `/currency [auto\|¥\|$]` | Toggle cost currency display |
| `/status-debug` | Dump session stats to `/tmp/pi-status-debug.log` |

## Status Bar Layout

```
~/projects/my-repo (main)                    deepseek-v3 · xhigh
in 12k, out 8k, cache 45k, total 65k · ¥0.12/50.00 · 12.3%/64k · 45s 38.2 tok/s · MCP:2(15)
```

Line 1: cwd + git branch (left) | model + thinking level (right)
Line 2: token stats · cost/balance · context · timing · MCP

## MCP Integration

When used with [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter), the status bar shows live MCP connection status via `mcp:status` and `mcp:disconnect` events.
