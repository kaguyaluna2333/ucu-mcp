# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-05

### Changed

- Replaced JXA keyboard/mouse input with native Swift CGEvent helper (`native/cgevent/cgevent-helper`), eliminating SIGSEGV crashes on macOS Sequoia+
- `listWindows` switched from `CGWindowListCopyWindowInfo` to System Events for reliable window enumeration
- `getWindowState` adapted to use System Events window IDs instead of CGWindow IDs
- Fixed OCR JXA script — `isValid` guard now correctly handles missing/broken references

### Fixed

- `typeInElement` now properly escapes `$` in text to prevent JXA template-literal interpolation errors
- AX element cache now refetches stale references instead of throwing
- MCP server version now resolves from `package.json` instead of advertising stale `0.1.0`
- `screenshot.maxWidth`, `screenshot.windowId`, and action `captureAfter` encode options now reach the execution path
- `captureAfter` now returns a separate MCP image content item instead of embedding screenshot bytes in JSON text
- Window-relative coordinate tools now reject stale `windowId` values instead of falling back to raw screen coordinates
- Real input actions no longer use the shared retry wrapper after a partial failure
- macOS AX traversal now uses `uiElements()` with `elements()` fallback, fixing TextEdit `AXTextArea` discovery
- User activity monitoring now starts with the MCP server and initializes the cursor baseline before polling
- Added client-friendly aliases and defaults: `press_key.modifiers`, `scroll.deltaX=0`, `wait_for_element.timeoutMs/intervalMs`, and `move.captureAfter`
- README tool tables and OCR/captureAfter response examples now match the live MCP schema
- macOS platform failures now use structured `UcuError` subclasses for screenshots, window lookup, AX permissions, stale elements, cursor queries, and input synthesis
- MCP tool failures now return `isError: true` with JSON `error.name`, `error.code`, `error.retryable`, `error.message`, and `error.recovery` instead of forcing clients to parse plain text
- `wait_for_element` no longer masks Accessibility/platform failures as ordinary timeouts; missing elements still time out, but real lookup failures surface through the structured MCP error response
- macOS `listWindows` now uses a short defensive-copy cache for repeated window lookups, reducing back-to-back window resolution calls from seconds to near-zero while `focusApp` still invalidates before activating a target app
- Added optional real client CLI smoke coverage for Claude Code CLI, Codex CLI, and OpenCode MCP visibility
- README now includes verified `claude mcp add`, `codex mcp add`, and OpenCode `opencode.json` setup paths

### Tests

- Unit test count grew from 83 → 161
- Optional client CLI smoke: 3/3 passing with `npm run test:client-cli`
- GUI smoke tests 6/6 passing (`UCU_MACOS_GUI_SMOKE=1`)

## [0.1.0] - 2026-06-02

### Added

- Initial release of UCU-MCP (Universal Computer Use MCP Server)
- **22 MCP tools** for desktop automation via Model Context Protocol:
  - Screen capture: `screen_capture`, `screen_capture_active_window`
  - Mouse control: `mouse_move`, `mouse_click`, `mouse_double_click`, `mouse_drag`, `mouse_scroll`
  - Keyboard control: `keyboard_type`, `keyboard_hotkey`, `keyboard_key`
  - Clipboard: `clipboard_read`, `clipboard_write`
  - Window management: `window_list`, `window_activate`, `window_close`
  - Application control: `app_launch`, `app_quit`
  - System: `system_info`, `process_list`, `process_terminate`
  - Safety: `doctor` command for permission and environment diagnostics
- **Safety features**:
  - URL blocklist to prevent navigation to sensitive sites
  - Lock screen guard (macOS) — blocks automation when screen is locked
  - Typed text injection scan — validates keyboard input before injection
  - Focus steal suppression — prevents accidental focus changes during automation
  - User interaction monitor — tracks user activity for safety coordination
- **macOS platform support** with Accessibility API integration
- TypeScript-first codebase with full type definitions
- CLI entry point with `doctor` diagnostic command

### Changed

- Rewrote `src/mcp/tools.ts` with comprehensive 22-tool registry:
  - Unified `withSafety` wrapper for all automation actions
  - `captureAfter` helper for post-action screenshots
  - `windowId` guard for window-scoped operations
  - Integrated safety report in `doctor` output

### Security

- Security audit fixes applied:
  - Input validation on all tool parameters
  - Safe handling of file paths and URLs
  - Rate limiting considerations for rapid automation

### Architecture

- `ARCHITECTURE.md` rewritten to document:
  - FocusStealSuppression implementation
  - UserInteractionMonitor design
  - Safety layer architecture
  - Tool registry patterns

[0.1.0]: https://github.com/2876674942/ucu-mcp-backup/releases/tag/v0.1.0
