# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-06-04

### Changed

- Replaced JXA keyboard/mouse input with native Swift CGEvent helper (`native/cgevent/cgevent-helper`), eliminating SIGSEGV crashes on macOS Sequoia+
- `listWindows` switched from `CGWindowListCopyWindowInfo` to System Events for reliable window enumeration
- `getWindowState` adapted to use System Events window IDs instead of CGWindow IDs
- Fixed OCR JXA script — `isValid` guard now correctly handles missing/broken references

### Fixed

- `typeInElement` now properly escapes `$` in text to prevent JXA template-literal interpolation errors
- AX element cache now refetches stale references instead of throwing

### Tests

- Unit test count grew from 83 → 142
- GUI smoke tests 8/8 passing (`UCU_MACOS_GUI_SMOKE=1`)

## [0.1.0] - 2025-06-02

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
