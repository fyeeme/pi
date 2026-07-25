# Changelog

## [1.0.0] - 2025-07-25

### Added

- Initial release of pi-peon-ping
- Route pi lifecycle events through peon.sh:
  - `session_start` → `SessionStart`
  - `turn_start` → `UserPromptSubmit`
  - `turn_end` → `Stop`
  - `tool_result` (isError) → `PostToolUseFailure`
  - `session_shutdown` → `SessionEnd`
- Terminal tab title updates with visual status indicators
- Auto-discovery of peon.sh at standard install paths
