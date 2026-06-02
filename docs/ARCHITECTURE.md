# Universal Computer Use MCP — Architecture

> Version: 0.1.0
> Last updated: 2026-06-02

## Overview

UCU-MCP is a stdio-based MCP server that gives AI agents desktop automation capabilities. The macOS path is the primary implementation; Windows and Linux adapters exist as explicit stubs.

The design follows Codex/Claude Code's native computer-use pattern: observe first (screenshots, window state), prefer AX element identities over pixel coordinates, recover from stale elements via refetch, and report readiness through `doctor`.

## Directory Structure

```
ucu-mcp/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── bin/
│   └── ucu-mcp.ts            # CLI entry (doctor, --help, or start stdio server)
│
├── src/
│   ├── index.ts               # Exports startServer, ToolRegistry, Platform, SafetyGuard, etc.
│   │
│   ├── mcp/                   # MCP protocol layer
│   │   ├── server.ts          # McpServer + instructions + registerTools
│   │   ├── tools.ts           # 22-tool registration, withSafety wrapper, ToolRegistry
│   │   └── transport.ts       # StdioServerTransport factory
│   │
│   ├── platform/              # Platform abstraction layer
│   │   ├── base.ts            # Platform interface + all supporting types
│   │   ├── macos.ts           # macOS implementation (JXA/CoreGraphics/System Events)
│   │   ├── windows.ts         # Windows stub
│   │   └── linux.ts           # Linux stub
│   │
│   ├── safety/                # Safety subsystem
│   │   ├── guard.ts           # SafetyGuard — key blocklist, window skip, URL blocklist, injection scan, rate limit
│   │   └── permissions.ts     # Accessibility + Screen Recording checks, runPermissionDoctor
│   │
│   ├── utils/                 # Platform-specific helpers
│   │   ├── screenshot.ts      # macOS screencapture CLI wrapper
│   │   └── input.ts           # macOS mouse/keyboard action factories
│   │
│   └── util/                  # General utilities
│       ├── errors.ts          # UcuError taxonomy (PlatformError, SafetyError, etc.)
│       ├── logger.ts          # Structured JSON logger (stderr, pino-compatible)
│       └── retry.ts           # Exponential backoff retry for retryable errors
│
├── tests/
│   ├── unit/
│   │   ├── safety-guard.test.ts
│   │   ├── permissions.test.ts
│   │   ├── screenshot.test.ts
│   │   ├── input.test.ts
│   │   └── macos-platform.test.ts
│   ├── integration/
│   │   ├── server.test.ts
│   │   ├── cli-mcp.test.ts
│   │   └── macos-gui-smoke.test.ts   # Gated: only runs with UCU_MACOS_GUI_SMOKE=1
│   └── vitest.config.ts
│
└── docs/
    ├── ARCHITECTURE.md
    ├── SAFETY.md
    ├── PLATFORM.md
    └── REVIEW.md
```

## Core Architecture

### Data Flow

```
MCP Client (Claude Code, OpenCode, etc.)
     │
     ▼  JSON-RPC over stdio
┌─────────────┐
│  McpServer   │  (src/mcp/server.ts)
│  + transport │  (src/mcp/transport.ts)
└──────┬───────┘
       │
       ▼
┌─────────────┐
│ registerTools│  (src/mcp/tools.ts)
│  22 tools    │
└──────┬───────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│  withSafety  │────▶│ SafetyGuard  │  key block / window skip / URL block / injection / rate
└──────┬───────┘     └──────────────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│   Platform   │────▶│ MacOSPlatform│  JXA + CoreGraphics + System Events
│   (base.ts)  │     │ Windows stub │
└──────────────┘     │ Linux stub   │
                     └──────────────┘
```

### withSafety Pipeline

Every action tool goes through `withSafety()` before execution:

1. **Lock-screen guard** — blocks all actions if macOS screen is locked
2. **SafetyGuard check** — key blocklist, window skip, URL blocklist, text injection scan, rate limit
3. **Permission check** — Accessibility for input tools, Screen Recording for capture tools
4. **Unsupported parameter** — rejects `windowId` on keyboard tools before dry-run
5. **Dry-run** — if `UCU_DRY_RUN=true`, returns `[DRY-RUN]` description without executing
6. **Execute with retry** — retryable errors (PlatformError, InputSynthesisError, CaptureError) get exponential backoff

### ToolRegistry

`ToolRegistry` serves two roles:
- **MCP registration**: `register(name)` appends tool name to the list for logging
- **Unit test dispatch**: `register(name, handler)` + `dispatch(name, args)` for testing tool wiring without MCP transport

## 22 MCP Tools

### Screen & Window (7)

| Tool | Platform Method | Safety |
|------|----------------|--------|
| `screenshot` | `screenshot()` | Screen Recording |
| `list_windows` | `listWindows()` | Accessibility |
| `list_apps` | `listApps()` | Accessibility |
| `focus_app` | `focusApp()` | Accessibility |
| `get_window_state` | `getWindowState()` | Accessibility |
| `get_screen_size` | `getScreenSize()` | None |
| `ocr` | `ocr()` | Screen Recording |

### Mouse & Input (5)

| Tool | Platform Method | Safety | captureAfter |
|------|----------------|--------|-------------|
| `click` | `click()` | Accessibility | Yes |
| `double_click` | `click(x,y,btn,true)` | Accessibility | Yes |
| `scroll` | `scroll()` | Accessibility | Yes |
| `drag` | `drag()` | Accessibility | Yes |
| `move` | `move()` | Accessibility | No |

### Keyboard (2)

| Tool | Platform Method | Safety | Notes |
|------|----------------|--------|-------|
| `type_text` | `type()` | Accessibility | `windowId` unsupported → `UnsupportedParameterError` |
| `press_key` | `key()` | Accessibility | `windowId` unsupported; accepts both `key` (string) and `keys` (array) |

### AX Element (4)

| Tool | Platform Method | Safety | Notes |
|------|----------------|--------|-------|
| `find_element` | `findElement()` | Accessibility | `includeBounds` default true; `maxResults` 1–200 default 50 |
| `click_element` | `clickElement()` | Accessibility | Refetches equivalent elements on stale cache |
| `set_value` | `setElementValue()` | Accessibility | Direct AX value assignment, no focus |
| `type_in_element` | `typeInElement()` | Accessibility | May focus element; refetches on stale cache |

### Runtime & Sync (4)

| Tool | Description | Safety |
|------|-------------|--------|
| `get_cursor_position` | `getCursorPosition()` | None |
| `doctor` | Permissions + safety readiness report | None |
| `wait` | Sleep N ms | None |
| `wait_for_element` | Poll AX tree until match | None |

### captureAfter Fields

9 action tools (`click`, `double_click`, `scroll`, `drag`, `type_text`, `press_key`, `click_element`, `set_value`, `type_in_element`) accept:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `captureAfter` | boolean | false | Append post-action screenshot to response |
| `captureMaxWidth` | number | 1280 | Max width for post-action capture |
| `captureFormat` | "png" \| "jpeg" | jpeg | Format for post-action capture |

## Platform Interface

Defined in `src/platform/base.ts`. Key types:

- `ScreenRegion`, `ScreenSize`, `ScreenshotOptions` — capture parameters
- `WindowInfo`, `AppInfo`, `AppTarget` — window/app identity
- `ElementInfo`, `OcrResult`, `FindElementOptions`, `FindElementResult` — AX element data
- `WindowState` — window + focusedElement + tree
- `BrowserContext` — app name + URL + title for safety checks
- `CursorPosition` — x, y

The `Platform` interface has 22+ methods. Optional methods (`listApps`, `focusApp`, `getActiveBrowserContext`, `screenshotWindow`, `setElementValue`, `isScreenLocked`) are only available on macOS.

## macOS Implementation

`src/platform/macos.ts` (~1431 lines) implements all Platform methods using:

- **JXA** (osascript -l JavaScript) for window listing, cursor, drag, scroll, focusApp, listApps, browser context, AX tree traversal, element refetch
- **AppleScript/System Events** for click, double-click, type, key press
- **CGEvent** for mouse move, keyboard injection (typeText), modifier key handling
- **screencapture CLI** for screenshots (delegated to `src/utils/screenshot.ts`)
- **Element cache** — `findElement` caches element descriptors; `clickElement`/`typeInElement`/`setElementValue` refetch equivalent elements when cache misses or signatures mismatch

Key implementation details:
- `isScreenLocked()` checks `/Users/shared/.com.apple.tsmd.progress` existence
- `getActiveBrowserContext()` reads URL/title from Safari, Chrome, Arc, Edge, Brave via JXA
- `getWindowState()` independently queries focusedUIElement, validates it belongs to the target window via bounds center check
- `setElementValue()` uses direct AX value assignment (no focus/keystroke)
- Type text uses CGEvent keyboard events for mappable characters, falls back to osascript for unmapped (emoji, CJK)
- OCR uses `shortcuts run "Get Text from Image"` on macOS 13+ or `tesseract` fallback

## Safety Model

See `docs/SAFETY.md` for full details. The SafetyGuard in `src/safety/guard.ts` runs 5 sequential checks:

1. **Key blocklist** — blocks Cmd+Q, Alt+F4, Ctrl+Alt+Del, etc.
2. **Window skip** — refuses actions on password manager / banking windows
3. **URL blocklist** — blocks sensitive URLs when browser context is available
4. **Text injection scan** — blocks shell substitution, command chaining, JXA primitives in typed text
5. **Rate limit** — minimum 100ms between actions

Safety features are additive — blocked keys and skipped windows extend the built-in lists, never replace them.

## Error Taxonomy

| Class | Code | Retryable | When |
|-------|------|-----------|------|
| `UcuError` | UCU_ERROR | false | Base class |
| `PlatformError` | PLATFORM_ERROR | true | Native API failure |
| `SafetyError` | SAFETY_BLOCKED | false | Action blocked by guard |
| `PermissionError` | PERMISSION_DENIED | false | Missing OS permission |
| `WindowNotFoundError` | WINDOW_NOT_FOUND | false | Window ID stale |
| `CoordinateError` | COORDINATE_OUT_OF_BOUNDS | false | Outside screen |
| `InputSynthesisError` | INPUT_FAILED | true | Mouse/keyboard injection failed |
| `CaptureError` | CAPTURE_FAILED | true | Screenshot/OCR failed |
| `UnsupportedParameterError` | UNSUPPORTED_PARAMETER | false | Unsupported param combination (rejected before dry-run) |

## Dependencies

Runtime:
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `zod` — schema validation (bundled with MCP SDK)

Dev:
- `typescript`, `vitest`, `tsx`, `@types/node`

No native addons or FFI — all platform interaction is via `child_process` (osascript, screencapture, sips, shortcuts).

## Build & Run

```bash
npm install
npm run build        # tsc → dist/
npm test             # vitest run
npm start            # node dist/bin/ucu-mcp.js

# CLI
node dist/bin/ucu-mcp.js --help
node dist/bin/ucu-mcp.js doctor

# GUI smoke (gated)
npm run test:macos-gui
```

## Known Limitations

- **Keyboard tools are focus-dependent** — `type_text` and `press_key` send to the currently focused window, not a specific windowId. Use `type_in_element` or `set_value` for targeted text entry.
- **No native addon** — All macOS calls go through `osascript`/`screencapture`/`sips` CLI, which is slower than FFI but requires no compilation.
- **Windows/Linux are stubs** — Methods throw explicit "not implemented" errors.
- **OCR quality varies** — Depends on macOS Shortcuts availability or tesseract installation.
- **Element cache is in-memory** — Not persisted across server restarts.
