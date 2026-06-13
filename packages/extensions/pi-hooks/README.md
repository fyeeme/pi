# pi-hooks

A Claude Code-compatible hooks runner for [pi](https://pi.dev). Reads `.pi/hooks.json` from your project and maps `SessionStart`, `PreToolUse`, and `Stop` events to pi lifecycle events — matching Claude Code's hooks protocol including stdin JSON and stdout `additionalContext` capture.

## Install

```bash
pi install npm:pi-hooks
```

Or project-local (shared with team):

```bash
pi install -l npm:pi-hooks
```

## Configuration

Create `.pi/hooks.json` in your project root:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks activate --client=claude-code"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks remind --client=claude-code"
          }
        ]
      },
      {
        "matcher": "plugin_serena_serena_*",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks auto-approve --client=claude-code"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "serena-hooks cleanup --client=claude-code"
          }
        ]
      }
    ]
  }
}
```

## Event Mapping

| hooks.json event | pi event | Notes |
|---|---|---|
| `SessionStart` | `session_start` | Runs on startup. `additionalContext` sent via `sendUserMessage`. |
| `PreToolUse` (empty matcher) | `tool_call` | Runs before every tool with real `tool_name`. `additionalContext` injected before next LLM call. |
| `PreToolUse` (pattern matcher) | `tool_call` | Glob match against pi tool name (e.g. `plugin_serena_serena_*`). |
| `Stop` | `session_shutdown` | Runs on exit. |

## Protocol

Commands receive Claude Code-compatible JSON on stdin:

```json
{ "type": "session_start", "session_id": "...", "transcript_path": "..." }
{ "type": "pre_tool_use", "session_id": "...", "tool_name": "bash", "tool_input": {} }
{ "type": "stop", "session_id": "..." }
```

Commands may return JSON on stdout:

```json
{ "hookSpecificOutput": { "additionalContext": "..." } }
```

The `additionalContext` is injected into the pi conversation.

## MCP Tool Names

Pi names MCP tools as `<serverName>_<toolName>` (not `mcp__server__tool` like Claude Code). Check your actual tool names with `/mcp` in pi to set the correct `matcher`.

## Config Override

Set `PI_HOOKS_CONFIG` env var to point to a custom config path.
