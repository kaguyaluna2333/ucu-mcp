# Universal Computer Use MCP — Architecture

> Version: 0.1.0-draft
> Last updated: 2026-06-01

## Current Implementation Note

The current codebase has moved from the original dispatcher-per-tool sketch to a compact MCP stdio server:

- `src/mcp/server.ts` creates `McpServer` with cross-client instructions for Claude Code CLI, Claude Code Desktop, OpenCode, and other MCP clients.
- `src/mcp/tools.ts` registers 22 tools directly: the original computer-use surface plus macOS target-context tools (`list_apps`, `focus_app`), `set_value`, `doctor`, `wait`, and `wait_for_element`.
- `src/platform/macos.ts` is the primary implementation path today, using JXA/CoreGraphics/System Events plus an AX element cache that can refetch equivalent elements when UI trees change.
- `src/safety/guard.ts` provides dangerous shortcut blocking, sensitive-window blocking, browser URL blocking, typed-text injection scanning, and rate limiting.
- macOS lock-screen checks block computer-use actions while the console is locked.

This keeps the public MCP surface stable while moving the runtime behavior closer to Codex Computer Use: observe first, prefer AX element identities, recover from stale elements, and report client readiness through `doctor`.

## 1. Directory Structure

```
ucu-mcp/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Entrypoint — creates & starts MCP server
│   ├── server.ts                   # MCP Server wiring (tool registration, transport)
│   ├── dispatcher.ts               # Tool Dispatcher — routes tool calls to handlers
│   │
│   ├── tools/                      # Tool handlers (one file per tool)
│   │   ├── screenshot.ts
│   │   ├── list-windows.ts
│   │   ├── get-window-state.ts
│   │   ├── click.ts
│   │   ├── double-click.ts
│   │   ├── type-text.ts
│   │   ├── press-key.ts
│   │   ├── scroll.ts
│   │   ├── drag.ts
│   │   └── index.ts                # Barrel export of all tool definitions
│   │
│   ├── platform/                   # Platform abstraction layer
│   │   ├── adapter.ts              # PlatformAdapter interface
│   │   ├── registry.ts             # Runtime platform detection & adapter factory
│   │   ├── macos/
│   │   │   ├── adapter.ts          # macOS implementation
│   │   │   ├── accessibility.ts    # AX API bindings via node-addon / FFI
│   │   │   ├── window-manager.ts   # CGWindowListCopyWindowInfo helpers
│   │   │   └── input.ts            # CGEvent mouse/keyboard synthesis
│   │   ├── windows/
│   │   │   ├── adapter.ts          # Windows implementation
│   │   │   ├── uia.ts              # UI Automation bindings via edge-js / FFI
│   │   │   ├── win32.ts            # Win32 fallback (SendMessage, SendInput)
│   │   │   └── window-manager.ts   # EnumWindows + GetWindowText helpers
│   │   └── linux/
│   │       ├── adapter.ts          # Linux implementation
│   │       ├── atspi.ts            # AT-SPI2 D-Bus bindings
│   │       ├── xdotool.ts          # X11 fallback via xdotool child_process
│   │       └── window-manager.ts   # wmctrl / xdotool window listing
│   │
│   ├── safety/                     # Safety Guard subsystem
│   │   ├── guard.ts                # SafetyGuard — central check pipeline
│   │   ├── rules.ts                # Built-in rule definitions
│   │   ├── config.ts               # User-configurable safety overrides
│   │   └── rules/
│   │       ├── key-blocklist.ts    # Dangerous key combo filtering
│   │       ├── window-skip.ts      # Sensitive window detection
│   │       ├── rate-limit.ts       # Action rate limiting
│   │       └── consent.ts          # Destructive-action consent prompts
│   │
│   ├── capture/                    # Screenshot & window-state capture
│   │   ├── screenshot.ts           # Cross-platform screenshot orchestrator
│   │   └── window-state.ts         # Window tree / element state extraction
│   │
│   ├── input/                      # Input synthesis abstraction
│   │   ├── mouse.ts                # Mouse action primitives
│   │   ├── keyboard.ts             # Keyboard action primitives
│   │   └── coords.ts               # Coordinate normalization (logical <-> physical)
│   │
│   └── util/
│       ├── logger.ts               # Structured logging (pino)
│       ├── errors.ts               # Typed error classes
│       ├── retry.ts                # Retry with backoff for flaky platform calls
│       └── image.ts                # PNG encoding, resize, base64 helpers
│
├── test/
│   ├── unit/
│   │   ├── dispatcher.test.ts
│   │   ├── safety/
│   │   │   ├── guard.test.ts
│   │   │   ├── key-blocklist.test.ts
│   │   │   └── rate-limit.test.ts
│   │   └── tools/
│   │       ├── screenshot.test.ts
│   │       └── click.test.ts
│   ├── integration/
│   │   ├── server.test.ts          # MCP protocol round-trip tests
│   │   └── platform/
│   │       ├── macos.test.ts
│   │       ├── windows.test.ts
│   │       └── linux.test.ts
│   └── fixtures/
│       └── mock-adapter.ts         # Mock PlatformAdapter for unit tests
│
└── docs/
    ├── ARCHITECTURE.md             # This file
    ├── SAFETY.md                   # Safety model documentation
    └── PLATFORM.md                 # Platform-specific setup notes
```

## 2. Core Module Design

### 2.1 MCP Server (`src/server.ts`)

Wraps `@modelcontextprotocol/sdk` to create a stdio-based MCP server. Registers all nine tools with their JSON Schema definitions. Delegates every tool call to the Tool Dispatcher.

```
┌──────────────────────────────────────────┐
│               MCP Server                 │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Tool Reg │  │ Transport│  │ Logger │ │
│  └────┬─────┘  └────┬─────┘  └────────┘ │
│       │              │                   │
│       ▼              ▼                   │
│  ┌──────────────────────┐                │
│  │   Tool Dispatcher    │                │
│  └──────────┬───────────┘                │
└─────────────┼────────────────────────────┘
              │
              ▼
    ┌──────────────────┐
    │   Safety Guard   │ ◄── block / allow / consent
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │  Platform Adapter│ ◄── macOS / Windows / Linux
    └──────────────────┘
```

**Lifecycle:**

1. `index.ts` detects platform via `process.platform`
2. `registry.ts` instantiates the correct `PlatformAdapter`
3. `SafetyGuard` is constructed with user config overrides
4. `Server` is created with the dispatcher wired to guard + adapter
5. Server connects via stdio transport and begins accepting requests

**Key implementation detail:** The server runs as a single-process Node.js application. Platform-native calls (AX API, UIA, AT-SPI2) are executed via `node:ffi-napi` or `node-addon-api` addons, keeping the event loop responsive. Long-running operations (e.g., full window-tree traversal) are wrapped in `Promise` and can be cancelled.

### 2.2 Platform Adapter (`src/platform/adapter.ts`)

The adapter is the **only** module that touches the OS. Every tool handler works exclusively through this interface, making platform code fully swappable.

```typescript
// src/platform/adapter.ts

import type { ScreenshotResult, WindowInfo, WindowState, ClickOptions, ScrollOptions, DragOptions } from '../types';

export interface PlatformAdapter {
  // Lifecycle
  init(): Promise<void>;
  destroy(): Promise<void>;

  // Window enumeration
  listWindows(): Promise<WindowInfo[]>;
  getWindowState(windowId: string): Promise<WindowState>;

  // Screen capture
  captureScreen(region?: ScreenRegion): Promise<ScreenshotResult>;
  captureWindow(windowId: string): Promise<ScreenshotResult>;

  // Input synthesis (non-invasive where the OS/input target allows it)
  click(options: ClickOptions): Promise<void>;
  doubleClick(options: ClickOptions): Promise<void>;
  typeText(text: string, options?: TypeOptions): Promise<void>;
  pressKey(key: string, modifiers?: string[]): Promise<void>;
  scroll(options: ScrollOptions): Promise<void>;
  drag(options: DragOptions): Promise<void>;

  // Cursor state (read-only — never moves cursor)
  getCursorPosition(): Promise<{ x: number; y: number }>;
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: string;
  title: string;
  processName: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
  isOnScreen: boolean;
}

export interface WindowState {
  window: WindowInfo;
  focusedElement?: ElementInfo;
  tree?: ElementInfo;       // Accessibility tree (depth-limited)
}

export interface ElementInfo {
  role: string;
  name: string;
  description?: string;
  value?: string;
  bounds: { x: number; y: number; width: number; height: number };
  children?: ElementInfo[];
  states: string[];         // focused, selected, enabled, etc.
}

export interface ClickOptions {
  x: number;
  y: number;
  windowId?: string;        // Coordinate space anchor
  button?: 'left' | 'right' | 'middle';
  coordinateSpace?: 'window' | 'screen';  // default: 'screen'
}

export interface TypeOptions {
  windowId?: string;        // Reserved for future targeted typing; current implementation uses focus
  delay?: number;           // ms between keystrokes
}

export interface ScrollOptions {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  windowId?: string;
}

export interface DragOptions {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  duration?: number;        // ms, default 300
  windowId?: string;
}
```

**Non-invasive contract:** The adapter MUST NOT move the physical cursor or steal focus unless the called primitive explicitly requires focus. Coordinate mouse tools synthesize events without moving the physical cursor. `set_value` uses direct AX value assignment and does not focus the element. `type_text`, `press_key`, and `type_in_element` are focus-dependent keyboard paths; callers should prefer `set_value` for editable AX elements when focus preservation matters.

**Platform implementations:**

| Platform | Accessibility | Input Synthesis | Window Enum | Screenshot |
|----------|--------------|-----------------|-------------|------------|
| macOS | AX API via `node-addon-api` | `CGEventPost` | `CGWindowListCopyWindowInfo` | `CGDisplayCreateImage` |
| Windows | UI Automation via `edge-js` | `SendInput` / `mouse_event` | `EnumWindows` + `GetWindowText` | `BitBlt` / `DXGI Desktop Duplication` |
| Linux | AT-SPI2 via D-Bus (`dbus-next`) | `xdotool` / `ydotool` | `wmctrl -l` / `xdotool` | `xdg-desktop-portal` / `scrot` |

### 2.3 Safety Guard (`src/safety/guard.ts`)

Every tool call passes through the Safety Guard **before** reaching the platform adapter. The guard is a pipeline of independent rules that can `allow`, `block`, or `requireConsent`.

```typescript
// src/safety/guard.ts

export type Verdict =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'consent'; reason: string };

export interface SafetyRule {
  name: string;
  evaluate(tool: string, args: Record<string, unknown>, context: SafetyContext): Promise<Verdict>;
}

export interface SafetyContext {
  platform: string;
  activeWindows: WindowInfo[];
  recentActions: ActionRecord[];
  config: SafetyConfig;
}

export class SafetyGuard {
  private rules: SafetyRule[];
  private config: SafetyConfig;

  constructor(config: SafetyConfig) {
    this.rules = [
      new KeyBlocklistRule(config),
      new WindowSkipRule(config),
      new RateLimitRule(config),
      new ConsentRule(config),
    ];
    this.config = config;
  }

  async check(
    tool: string,
    args: Record<string, unknown>,
    context: SafetyContext,
  ): Promise<Verdict> {
    for (const rule of this.rules) {
      const verdict = await rule.evaluate(tool, args, context);
      if (verdict.action !== 'allow') return verdict;
    }
    return { action: 'allow' };
  }
}
```

**Built-in rules:**

| Rule | File | What it does |
|------|------|-------------|
| `KeyBlocklistRule` | `rules/key-blocklist.ts` | Blocks dangerous shortcuts: Cmd+Q, Alt+F4, Ctrl+Alt+Del, Cmd+Option+Esc, system-level combos. Configurable allowlist override. |
| `WindowSkipRule` | `rules/window-skip.ts` | Skips actions targeting windows whose title/process matches patterns: password managers, system preferences, lock screens, terminal with `sudo`. |
| `RateLimitRule` | `rules/rate-limit.ts` | Throttles tool calls to configurable max-per-second (default: 10 actions/sec). Prevents runaway loops. |
| `ConsentRule` | `rules/consent.ts` | Requires explicit MCP-side confirmation for destructive actions (closing windows, pressing power-adjacent keys). |

**Safety config (`src/safety/config.ts`):**

```typescript
export interface SafetyConfig {
  // Key blocking
  blockedKeys: string[];              // Default: ['cmd+q', 'alt+f4', 'ctrl+alt+delete', ...]
  allowedKeysOverride: string[];      // User can unblock specific combos

  // Window skipping
  skipWindowPatterns: string[];       // Default: ['*Password*', '*Keychain*', '*Task Manager*', ...]
  skipProcessPatterns: string[];      // Default: ['1Password', 'KeePass', 'LastPass', ...]

  // Rate limiting
  maxActionsPerSecond: number;        // Default: 10
  maxActionsPerMinute: number;        // Default: 200

  // Consent
  requireConsentFor: string[];        // Default: ['press_key:cmd+q', 'press_key:alt+f4', ...]

  // Global
  dryRun: boolean;                    // If true, log but don't execute
}
```

### 2.4 Tool Dispatcher (`src/dispatcher.ts`)

Routes incoming MCP tool calls to the correct handler after passing through the safety guard.

```typescript
// src/dispatcher.ts

export class ToolDispatcher {
  private guard: SafetyGuard;
  private adapter: PlatformAdapter;
  private handlers: Map<string, ToolHandler>;

  constructor(guard: SafetyGuard, adapter: PlatformAdapter) {
    this.guard = guard;
    this.adapter = adapter;
    this.handlers = new Map();
    this.registerDefaults();
  }

  async dispatch(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    // 1. Build safety context
    const context = await this.buildContext();

    // 2. Run through safety guard
    const verdict = await this.guard.check(toolName, args, context);
    if (verdict.action === 'block') {
      return {
        content: [{ type: 'text', text: `Blocked by safety guard: ${verdict.reason}` }],
        isError: true,
      };
    }
    if (verdict.action === 'consent') {
      return {
        content: [{
          type: 'text',
          text: `Requires consent: ${verdict.reason}. Re-call with { "consent": true } to proceed.`,
        }],
      };
    }

    // 3. Execute handler
    const handler = this.handlers.get(toolName);
    if (!handler) throw new Error(`Unknown tool: ${toolName}`);
    return handler.execute(args, this.adapter);
  }
}
```

### 2.5 Capture Module (`src/capture/`)

**Screenshot orchestration** (`screenshot.ts`):
- Requests screenshot from adapter (full screen or window)
- Converts to PNG via `sharp` or native encoder
- Returns base64-encoded image + metadata (dimensions, timestamp)
- Optional downscaling for token efficiency (default: max 1280px wide)

**Window state extraction** (`window-state.ts`):
- Walks the accessibility tree from a window root
- Caps depth at 5 levels (configurable) to avoid huge payloads
- Extracts focused element path separately for efficiency
- Returns structured `WindowState` with element hierarchy

### 2.6 Input Module (`src/input/`)

Provides higher-level input primitives on top of raw adapter calls:

- **`coords.ts`**: Normalizes coordinates between logical (CSS-pixel-like) and physical (screen-pixel) spaces. Handles Retina/HiDPI scaling per platform.
- **`mouse.ts`**: Composes click, double-click, drag sequences with timing control.
- **`keyboard.ts`**: Maps key names (`"enter"`, `"cmd+a"`) to platform-specific keycodes. Handles modifier state.

## 3. Tool Schema Definitions

All tools are registered with JSON Schema for parameter validation. Below are the complete definitions.

### 3.1 `screenshot`

```json
{
  "name": "screenshot",
  "description": "Capture a screenshot of the full screen or a specific window. Returns a base64-encoded PNG.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "windowId": {
        "type": "string",
        "description": "Target window ID. If omitted, captures the full primary screen."
      },
      "region": {
        "type": "object",
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "width": { "type": "number" },
          "height": { "type": "number" }
        },
        "required": ["x", "y", "width", "height"],
        "description": "Crop region in screen coordinates. Ignored if windowId is set."
      },
      "maxWidth": {
        "type": "number",
        "default": 1280,
        "description": "Maximum output width in pixels. Aspect ratio is preserved."
      },
      "format": {
        "type": "string",
        "enum": ["png", "jpeg"],
        "default": "png"
      }
    },
    "required": []
  }
}
```

### 3.2 `list_windows`

```json
{
  "name": "list_windows",
  "description": "List all visible on-screen windows with their IDs, titles, process names, and bounds.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "includeMinimized": {
        "type": "boolean",
        "default": false,
        "description": "Include minimized/hidden windows."
      }
    },
    "required": []
  }
}
```

### 3.3 `get_window_state`

```json
{
  "name": "get_window_state",
  "description": "Get the accessibility tree and focused element of a window. If windowId is omitted, uses the prior focus_app target when available.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "windowId": {
        "type": "string",
        "description": "Target window ID. If omitted, uses the prior focus_app target when available."
      },
      "depth": {
        "type": "number",
        "default": 3,
        "minimum": 1,
        "maximum": 10,
        "description": "Maximum depth of the accessibility tree to return."
      },
      "includeBounds": {
        "type": "boolean",
        "default": true,
        "description": "Include element bounding boxes."
      }
    },
    "required": []
  }
}
```

### 3.4 Action Feedback (`captureAfter`)

Action tools that can change UI state (`click`, `double_click`, `scroll`, `drag`, `type_text`, `press_key`, `click_element`, `set_value`, `type_in_element`) accept a shared optional feedback block:

```json
{
  "captureAfter": false,
  "captureMaxWidth": 1280,
  "captureFormat": "jpeg"
}
```

When `captureAfter` is true, the server appends a post-action screenshot to the same MCP response. The action is executed once; post-capture failure is reported as an additional text item instead of retrying the action.

### 3.5 `click`

```json
{
  "name": "click",
  "description": "Click at a screen position. Non-invasive: does not move the physical cursor.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "x": { "type": "number", "description": "X coordinate." },
      "y": { "type": "number", "description": "Y coordinate." },
      "windowId": {
        "type": "string",
        "description": "If set, coordinates are relative to this window. Otherwise, screen-absolute."
      },
      "button": {
        "type": "string",
        "enum": ["left", "right", "middle"],
        "default": "left"
      }
    },
    "required": ["x", "y"]
  }
}
```

### 3.6 `double_click`

```json
{
  "name": "double_click",
  "description": "Double-click at a screen position.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "x": { "type": "number" },
      "y": { "type": "number" },
      "windowId": { "type": "string" },
      "button": {
        "type": "string",
        "enum": ["left", "right", "middle"],
        "default": "left"
      }
    },
    "required": ["x", "y"]
  }
}
```

### 3.7 `type_text`

```json
{
  "name": "type_text",
  "description": "Type text into the currently focused element. Uses OS-level key events, not clipboard.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "description": "Text to type. Supports Unicode."
      },
      "windowId": {
        "type": "string",
        "description": "Reserved for future targeted typing. Currently unsupported; omit it and use the focused element or type_in_element/set_value."
      },
      "delay": {
        "type": "number",
        "default": 30,
        "minimum": 0,
        "maximum": 500,
        "description": "Milliseconds between keystrokes. Higher values simulate human typing."
      }
    },
    "required": ["text"]
  }
}
```

### 3.8 `press_key`

```json
{
  "name": "press_key",
  "description": "Press a key or key combination. Pass through safety guard — dangerous combos may be blocked.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "description": "Key name: 'enter', 'tab', 'escape', 'backspace', 'delete', 'a'-'z', '0'-'9', 'f1'-'f12', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'space'."
      },
      "modifiers": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["cmd", "ctrl", "alt", "shift", "meta", "super"]
        },
        "description": "Modifier keys to hold during the press."
      },
      "windowId": {
        "type": "string",
        "description": "Reserved for future targeted key events. Currently unsupported; omit it to send to the focused window."
      }
    },
    "required": ["key"]
  }
}
```

### 3.9 `scroll`

```json
{
  "name": "scroll",
  "description": "Scroll at a position. Supports both vertical and horizontal scrolling.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "x": { "type": "number", "description": "X coordinate of scroll point." },
      "y": { "type": "number", "description": "Y coordinate of scroll point." },
      "deltaX": {
        "type": "number",
        "default": 0,
        "description": "Horizontal scroll amount. Positive = right."
      },
      "deltaY": {
        "type": "number",
        "description": "Vertical scroll amount. Positive = down. Negative = up."
      },
      "windowId": { "type": "string" }
    },
    "required": ["x", "y", "deltaY"]
  }
}
```

### 3.10 `drag`

```json
{
  "name": "drag",
  "description": "Drag from one position to another. Simulates mouse-down, move, mouse-up.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "startX": { "type": "number" },
      "startY": { "type": "number" },
      "endX": { "type": "number" },
      "endY": { "type": "number" },
      "duration": {
        "type": "number",
        "default": 300,
        "minimum": 50,
        "maximum": 5000,
        "description": "Duration of the drag in milliseconds."
      },
      "windowId": { "type": "string" }
    },
    "required": ["startX", "startY", "endX", "endY"]
  }
}
```

## 4. Error Handling Strategy

### 4.1 Error Taxonomy

```typescript
// src/util/errors.ts

export abstract class UcuError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
}

export class PlatformError extends UcuError {
  readonly code = 'PLATFORM_ERROR';
  retryable = true;
  // Native API call failed (permissions, OS error, timeout)
}

export class SafetyBlockError extends UcuError {
  readonly code = 'SAFETY_BLOCKED';
  retryable = false;
  // Action blocked by safety guard
}

export class WindowNotFoundError extends UcuError {
  readonly code = 'WINDOW_NOT_FOUND';
  retryable = false;
  // Requested window ID no longer exists
}

export class CoordinateError extends UcuError {
  readonly code = 'COORDINATE_OUT_OF_BOUNDS';
  retryable = false;
  // Click/scroll target is outside screen bounds
}

export class InputSynthesisError extends UcuError {
  readonly code = 'INPUT_FAILED';
  retryable = true;
  // Keystroke or mouse event injection failed
}

export class CaptureError extends UcuError {
  readonly code = 'CAPTURE_FAILED';
  retryable = true;
  // Screenshot or window-state capture failed
}

export class PermissionError extends UcuError {
  readonly code = 'PERMISSION_DENIED';
  retryable = false;
  // Missing OS accessibility/screen-recording permissions
}

export class UnsupportedParameterError extends UcuError {
  readonly code = 'UNSUPPORTED_PARAMETER';
  retryable = false;
  // Unsupported but deterministic parameter combination
}
```

### 4.2 Error Handling Rules

1. **All platform errors surface as MCP tool errors** with `isError: true` and a human-readable message + error code.
2. **Retryable errors** are retried up to 3 times with exponential backoff (100ms, 300ms, 900ms). Only `PlatformError`, `InputSynthesisError`, and `CaptureError` are retryable.
3. **Permission errors** include setup instructions in the message (e.g., "Grant Screen Recording permission in System Settings > Privacy & Security").
4. **Safety blocks** are never retried. The message explains which rule blocked the action and how to override if appropriate.
5. **Window-not-found** errors suggest re-running `list_windows` to get fresh IDs.
6. **Coordinate errors** include the valid bounds so the caller can adjust.
7. **Unsupported parameter errors** are rejected before dry-run and before retry so clients do not receive false success or waste time retrying deterministic capability gaps.
8. **Unhandled errors** are caught at the dispatcher level, logged with full stack trace (pino), and returned as a generic `PLATFORM_ERROR` to the MCP client — never raw stack traces.

### 4.3 Logging

All operations are logged via `pino` with structured fields:

```json
{
  "level": "info",
  "tool": "click",
  "args": { "x": 500, "y": 300 },
  "verdict": "allow",
  "duration": 12,
  "platform": "macos",
  "timestamp": "2026-05-27T15:30:00.000Z"
}
```

Log levels:
- `debug`: Full args, platform API calls, coordinate transforms
- `info`: Tool invocations, verdicts, durations
- `warn`: Safety rule triggers, retries, fallbacks
- `error`: Failures, permission issues

## 5. Testing Strategy

### 5.1 Unit Tests (vitest)

| Module | What to test | Mock strategy |
|--------|-------------|---------------|
| `SafetyGuard` | All rules with edge cases (empty args, unicode window titles, rate bursts) | Mock `SafetyContext` |
| `KeyBlocklistRule` | Blocked combos, overrides, platform-specific modifiers | Pure function tests |
| `WindowSkipRule` | Pattern matching, glob wildcards, process name matching | Mock `WindowInfo[]` |
| `RateLimitRule` | Burst handling, sliding window, recovery after cooldown | Fake timers |
| `Dispatcher` | Routing, error propagation, consent flow | Mock adapter + guard |
| `coords.ts` | Logical-to-physical conversion, Retina scaling | Fixture dimensions |
| `keyboard.ts` | Key name parsing, modifier combinations | Pure function tests |
| `tools/*.ts` | Schema validation, result formatting | Mock adapter |

**Target: 90%+ line coverage on safety and dispatcher modules.**

### 5.2 Integration Tests (vitest + real MCP transport)

| Test | What it validates |
|------|-------------------|
| `server.test.ts` | Full MCP protocol round-trip: start server, connect client, call each tool, validate response schema |
| `platform/macos.test.ts` | Adapter init, list windows, capture screenshot on a real macOS session (CI: skip if no display) |
| `platform/windows.test.ts` | Same for Windows (CI: skip on non-Windows) |
| `platform/linux.test.ts` | Same for Linux with X11/Wayland (CI: uses Xvfb) |

**Platform integration tests are gated by environment:**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getPlatformAdapter } from '../src/platform/registry';

const describePlatform = process.env.CI_PLATFORM_TESTS ? describe : describe.skip;

describePlatform('macOS adapter', () => {
  let adapter: PlatformAdapter;

  beforeAll(async () => {
    adapter = getPlatformAdapter('darwin');
    await adapter.init();
  });

  it('lists at least one window', async () => {
    const windows = await adapter.listWindows();
    expect(windows.length).toBeGreaterThan(0);
  });

  it('captures a screenshot', async () => {
    const result = await adapter.captureScreen();
    expect(result.base64).toBeTruthy();
    expect(result.width).toBeGreaterThan(0);
  });
});
```

### 5.3 Mock Adapter (`test/fixtures/mock-adapter.ts`)

A full `PlatformAdapter` implementation returning deterministic fixture data. Used in all unit tests to isolate logic from platform:

```typescript
export class MockAdapter implements PlatformAdapter {
  windows: WindowInfo[] = [/* fixture data */];
  lastAction: { tool: string; args: Record<string, unknown> } | null = null;

  async listWindows() { return this.windows; }
  async click(opts: ClickOptions) { this.lastAction = { tool: 'click', args: opts }; }
  // ... all methods record calls for assertion
}
```

### 5.4 E2E Smoke Tests

Run against a real desktop session (manual or CI with virtual display):

1. Start ucu-mcp server
2. Connect via MCP client
3. `list_windows` — verify at least one window returned
4. `screenshot` — verify non-empty PNG returned
5. `get_window_state` — verify tree structure
6. `click` on a known coordinate — verify no error
7. `type_text` into a text editor — verify text appears
8. `press_key("a")` — verify key event
9. `scroll` — verify no error
10. Safety: `press_key("q", ["cmd"])` — verify blocked

### 5.5 Test Commands

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --dir test/unit",
    "test:integration": "vitest run --dir test/integration",
    "test:coverage": "vitest run --coverage",
    "test:platform": "CI_PLATFORM_TESTS=1 vitest run --dir test/integration/platform"
  }
}
```

## 6. Non-Invasive Mode — Design Rationale

The default behavior is **non-invasive where the underlying macOS primitive supports it**: coordinate mouse tools preserve the physical cursor, observation tools do not activate windows, and `set_value` writes AX values directly. Keyboard event tools remain focus-dependent unless a future platform backend adds true targeted key delivery.

**How it works per platform:**

| Action | macOS | Windows | Linux |
|--------|-------|---------|-------|
| `click(x, y)` | `CGEventPost` at coordinates without moving cursor | `SendInput` with `MOEVENTF_ABSOLUTE` | `xdotool mousemove --sync` + click (stores & restores cursor) |
| `typeText(text)` | `CGEventPost` key events to the focused element; unsupported characters fall back to System Events keystroke | `SendInput` key events | `xdotool type --window <id>` |
| focus steal? | Avoided for observation, coordinate mouse events, and `set_value`; keyboard tools are focus-dependent | Never by default | `xdotool windowfocus --sync` only if explicitly requested |

**Targeted keyboard mode:** A future backend may add true window-targeted typing/key events. In v1, keyboard tools are intentionally explicit about using the currently focused element/window.

## 7. Dependency Summary

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "pino": "^9.0.0",
    "sharp": "^0.33.0",
    "ffi-napi": "^4.0.0",
    "ref-napi": "^3.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "tsx": "^4.0.0"
  }
}
```

Platform-specific optional dependencies:
- **macOS:** `node-addon-api` (for AX API addon)
- **Windows:** `edge-js` or `ffi-napi` (for UI Automation)
- **Linux:** `dbus-next` (for AT-SPI2 D-Bus), child_process for `xdotool`/`wmctrl`

## 8. Build & Run

```bash
# Install
npm install

# Build
npm run build           # tsc -> dist/

# Run (stdio transport — for MCP client integration)
node dist/index.js

# Run with custom safety config
UCU_SAFETY_CONFIG=./safety.json node dist/index.js

# Dry run (no actual input synthesis)
UCU_DRY_RUN=1 node dist/index.js
```

## 9. Future Considerations (Out of Scope for v1)

- **WebSocket transport** for remote control scenarios
- **OCR integration** for text extraction from screenshots
- **Element-level actions** (`click_element`, `find_element`) via accessibility tree querying
- **Macro recording** — record and replay action sequences
- **Multi-monitor support** — explicit display ID parameter
- **Wayland native** support (currently falls back to xdg-desktop-portal)
