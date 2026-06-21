# ucu-mcp

Universal Computer Use MCP — desktop automation for any AI agent.

## Overview

UCU-MCP (Universal Computer Use MCP) is a Model Context Protocol server that gives AI agents cross-platform desktop automation capabilities. Its macOS path favors non-invasive observation and input where the OS allows it: coordinate mouse events preserve the physical cursor, `set_value` writes AX values directly, and focused keyboard typing is explicit.

## Features

- **Universal**: Works with Claude Code, OpenCode, Codex, Gemini CLI, and any MCP client
- **Cross-platform architecture**: macOS is the active implementation; Windows and Linux adapters fail explicitly until their native backends are completed
- **Non-invasive where possible**: Coordinate mouse events preserve cursor position; `set_value` avoids focusing AX elements; tools that require current focus say so explicitly
- **Codex-inspired**: AX element refetch, MCP instructions, lock-screen guard, URL blocklist, and runtime doctor checks
- **Safe**: Built-in permission checks and dangerous action interception
- **Extensible**: Modular architecture, easy to add new platforms and tools

## Installation

### Global install (recommended)

```bash
npm install -g ucu-mcp
```

Then run:

```bash
ucu-mcp
```

### One-shot with npx (no install required)

```bash
npx -y ucu-mcp
```

## Claude Desktop Integration

1. Copy the configuration below to your Claude Desktop config file:

   **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

   **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

2. Add this entry to the `mcpServers` object:

```json
{
  "mcpServers": {
    "ucu-mcp": {
      "command": "npx",
      "args": ["-y", "ucu-mcp"]
    }
  }
}
```

If you installed globally, you can use the shorter form:

```json
{
  "mcpServers": {
    "ucu-mcp": {
      "command": "ucu-mcp"
    }
  }
}
```

3. Restart Claude Desktop. The UCU-MCP tools will appear automatically.

## Tool List

UCU-MCP provides 26 tools across five categories:

### Screen & Window

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `screenshot` | Capture screen, window, or region as PNG/JPEG image content; `describe=true` appends a structured text description (OCR + AX) for vision-degraded environments | `display?`, `windowId?`, `region?`, `maxWidth?`, `format?`, `describe?`, `describeOptions?` |
| `describe_screen` | Structured text description of the screen (OCR blocks + AX tree + foreground window) — the vision-degraded fallback when image content is not visible to the model. Password fields are masked. | `display?`, `ocr?`, `includeAx?`, `axDepth?`, `ocrBlocks?`, `windowId?` |
| `list_windows` | List all on-screen windows with IDs, titles, bounds | `includeMinimized?` |
| `list_apps` | List visible macOS apps with pid, frontmost state, and window count | — |
| `focus_app` | Select an app/window target context for later AX tools; returns `targetId`, `appName`, `pid`, `windowId`, `title`, and `capturedAt`. Falls back to a tray target for menu-bar-only apps. | `app` |
| `get_window_state` | Get accessibility tree of a window, or the prior focus_app target when windowId is omitted | `windowId?`, `depth?`, `includeBounds?` |
| `get_screen_size` | Get screen dimensions | `display?` |
| `ocr` | Perform OCR on screen or region; returns text with bounding boxes and confidence | `display?`, `region?` |

### Mouse & Input

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `click` | Click at screen coordinates (non-invasive) | `x`, `y`, `windowId?`, `button?` |
| `double_click` | Double-click at screen coordinates | `x`, `y`, `windowId?`, `button?` |
| `scroll` | Scroll at a position (vertical/horizontal) | `x`, `y`, `deltaX?`, `deltaY`, `windowId?`, `captureAfter?` |
| `drag` | Drag from one position to another | `startX`, `startY`, `endX`, `endY`, `windowId?`, `duration?`, `button?`, `captureAfter?` |
| `move` | Move the physical cursor to a position (invasive) | `x`, `y`, `windowId?`, `captureAfter?` |
| `get_cursor_position` | Get current cursor position | — |

### Keyboard

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `type_text` | Type text into the currently focused element via OS key events (not clipboard) | `text`, `delay?`, `captureAfter?` |
| `press_key` | Press key or keyboard shortcut in the focused window | `key?`, `modifiers?`, `keys?`, `captureAfter?` |

### AX Element Interaction

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `find_element` | Find UI element by text, role, or description using AX APIs, using the current focus_app target when app is omitted | `text?`, `role?`, `app?`, `depth?`, `includeBounds?`, `maxResults?` |
| `click_element` | Click an AX element by its id (from find_element), using the current focus_app target when app is omitted; refetches equivalent elements after UI updates | `elementId`, `app?`, `captureAfter?` |
| `set_value` | Set an AX element's value directly without focusing it, using the current focus_app target when app is omitted | `elementId`, `value`, `app?`, `captureAfter?` |
| `type_in_element` | Type text into a specific AX text field element; may focus the element and refetches equivalent elements after UI updates | `elementId`, `text`, `app?`, `clearFirst?`, `captureAfter?` |
| `click_menu_bar_extra` | Click a menu-bar status item (tray icon) — for menu-bar-only apps (e.g. cc-switch) that focus_app cannot target. Finds items in the app's own menu bar or hosted by SystemUIServer. | `app`, `description?`, `name?`, `index?`, `captureAfter?` |

### Runtime & Synchronization

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `doctor` | Check platform readiness, permissions, lock-screen state, and client integration hints | — |
| `wait` | Wait for UI state to settle after launches, animations, or navigation | `ms` |
| `wait_for_element` | Poll the AX tree until a matching element appears | `text?`, `role?`, `app?`, `timeout?`, `timeoutMs?`, `interval?`, `intervalMs?` |
| `clipboard_read` | Read the current contents of the system clipboard | — |
| `clipboard_write` | Write text to the system clipboard (text-injection patterns are blocked) | `text`, `captureAfter?` |

Action tools accept `captureAfter`, `captureMaxWidth`, and `captureFormat` so an agent can receive a post-action screenshot as a second MCP image content item in the same response instead of spending another round trip on `screenshot`. When `captureAfter` is requested and the action succeeds, the tool returns an `ActionReceipt` (see the Action Receipt section below) with `capture.status: "ok"`. If post-action capture fails, the receipt has `status: "partial"` and `capture.status: "error"` with the error details. If `captureAfter` is omitted, `capture.status` is `"skipped"`.

For fast AX discovery on large windows, use `find_element` with `includeBounds=false` and a small `maxResults`. Keep bounds enabled when the result may be used for coordinate fallback.

`focus_app` establishes a session target for follow-up observation and AX actions. After focusing an app, `get_window_state` may omit `windowId`, and AX tools may omit `app`. If the focused window closes or is replaced, UCU-MCP returns a structured `TARGET_STALE` error so the agent can refresh with `focus_app` or `list_windows` instead of silently acting on a different target.

## OCR Tool Usage

The `ocr` tool captures a screenshot and runs optical character recognition, returning each detected text element with its position and confidence score.

**Example — read all text on screen:**

```json
{
  "tool": "ocr",
  "arguments": {}
}
```

**Example — read text in a specific region:**

```json
{
  "tool": "ocr",
  "arguments": {
    "region": { "x": 100, "y": 200, "width": 600, "height": 400 }
  }
}
```

**Response format:**

```json
{
  "fullText": "Detected text here",
  "elements": [
    {
      "text": "Hello",
      "x": 120,
      "y": 210,
      "width": 80,
      "height": 24,
      "confidence": 0.97
    }
  ]
}
```

## AX Element Interaction Usage

The AX (Accessibility) element tools let you interact with UI controls by their semantic identity rather than pixel coordinates — more reliable than screenshot-and-click patterns.

**Step 1 — Find an element:**

```json
{
  "tool": "find_element",
  "arguments": {
    "text": "Submit",
    "role": "AXButton",
    "app": "Safari"
  }
}
```

**Step 2 — Click the element by its id:**

```json
{
  "tool": "click_element",
  "arguments": {
    "elementId": "AXButton-42",
    "app": "Safari"
  }
}
```

**Step 3 — Type into a text field element:**

```json
{
  "tool": "type_in_element",
  "arguments": {
    "elementId": "AXTextField-7",
    "text": "hello@example.com",
    "app": "Safari",
    "clearFirst": true
  }
}
```

## Action Receipt

Action tools (`click`, `double_click`, `scroll`, `drag`, `move`, `type_text`, `press_key`, `click_element`, `set_value`, `type_in_element`) return a unified `ActionReceipt` JSON object that wraps the action result, target information, and optional post-action screenshot metadata.

### Receipt structure

| Field | Type | Description |
|-------|------|-------------|
| `actionId` | `string` | Unique base36-timestamp ID (e.g. `a1x9z2k-1`) |
| `action` | `string` | Tool name that produced this receipt |
| `status` | `"ok" \| "partial" \| "blocked"` | Overall action status |
| `target` | `object` | What was acted upon (coordinates, elementId, app, windowId) |
| `result` | `object` | Original business result (clicked, x, y, etc.) |
| `capture` | `object` | Screenshot metadata (requested, status, format, maxWidth, error) |
| `warnings` | `string[]` | Non-fatal warnings array |
| `next` | `string` | Suggested next action |

### Examples

**Success with captureAfter:**

```json
{
  "actionId": "a1x9z2k-1",
  "action": "click",
  "status": "ok",
  "target": { "x": 100, "y": 200 },
  "result": { "clicked": true, "x": 100, "y": 200 },
  "capture": {
    "requested": true,
    "status": "ok",
    "format": "jpeg",
    "maxWidth": 1280
  },
  "warnings": [],
  "next": "find_element or get_window_state"
}
```

**Success without captureAfter:**

```json
{
  "actionId": "a1x9z2k-2",
  "action": "click_element",
  "status": "ok",
  "target": { "elementId": "AXButton-42", "app": "Safari" },
  "result": { "clicked": true, "elementId": "AXButton-42" },
  "capture": {
    "requested": false,
    "status": "skipped"
  },
  "warnings": [],
  "next": "find_element or get_window_state"
}
```

**Partial when capture fails:**

```json
{
  "actionId": "a1x9z2k-3",
  "action": "click",
  "status": "partial",
  "target": { "x": 100, "y": 200 },
  "result": { "clicked": true, "x": 100, "y": 200 },
  "capture": {
    "requested": true,
    "status": "error",
    "format": "jpeg",
    "maxWidth": 1280,
    "error": {
      "name": "CaptureError",
      "code": "CAPTURE_FAILED",
      "retryable": true,
      "message": "Screenshot capture failed after action",
      "recovery": "Check Screen Recording permission and retry."
    }
  },
  "warnings": ["Post-action screenshot capture failed"],
  "next": "screenshot"
}
```

## macOS Permission Setup

UCU-MCP on macOS requires two system permissions:

### 1. Accessibility (required for click, type, key, drag, scroll, move)

1. Open **System Settings** > **Privacy & Security** > **Accessibility**
2. Click the **+** button
3. Add your terminal app (e.g., `/Applications/Utilities/Terminal.app`, or iTerm2, or the app that runs `ucu-mcp`)
4. Ensure the toggle next to the app is **enabled**

### 2. Screen Recording (required for screenshot, ocr, list_windows, get_screen_size)

1. Open **System Settings** > **Privacy & Security** > **Screen Recording**
2. Click the **+** button
3. Add your terminal app
4. Ensure the toggle is **enabled**

### Verify permissions

```bash
ucu-mcp doctor
```

This checks both permissions and reports any issues.

### Troubleshooting

- If you granted permission but tools still fail, **restart the terminal** or the app running ucu-mcp.
- On macOS Sequoia and later, you may need to re-grant Screen Recording after OS updates.
- If using Claude Desktop, the "Claude" app itself needs both permissions (not your terminal).

## Configuration for MCP Clients

UCU-MCP runs as a stdio MCP server. This is the common integration path for Claude Code CLI, Claude Code Desktop, OpenCode, and other local MCP clients.

### Claude Code CLI

Verified CLI setup:

```bash
claude mcp add --scope user ucu -- ucu-mcp
claude mcp list
```

Equivalent config shape:

```json
{
  "mcpServers": {
    "ucu": {
      "type": "stdio",
      "command": "ucu-mcp"
    }
  }
}
```

### Claude Code Desktop

Use the same local MCP server shape as Claude Desktop. Grant Accessibility and Screen Recording to the desktop app that launches `ucu-mcp`.

```json
{
  "mcpServers": {
    "ucu": {
      "type": "stdio",
      "command": "ucu-mcp"
    }
  }
}
```

### Codex CLI

Verified CLI setup:

```bash
codex mcp add ucu -- ucu-mcp
codex mcp list
```

Equivalent `~/.codex/config.toml` shape:

```toml
[mcp_servers.ucu]
command = "ucu-mcp"
```

### OpenCode

OpenCode reads MCP servers from `~/.config/opencode/opencode.json`.

```json
{
  "mcp": {
    "ucu-mcp": {
      "type": "local",
      "enabled": true,
      "command": ["ucu-mcp"]
    }
  }
}
```

Verify with:

```bash
opencode mcp list
```

### Runtime Doctor

```bash
ucu-mcp doctor
```

The same readiness report is also available as the MCP `doctor` tool.

## Agent Skill

UCU-MCP ships an installable **agent skill** written for **CLI agents** (Claude
Code, Codex, OpenCode) that connect via stdio MCP and drive the desktop one
tool call at a time. It gives richer guidance than the embedded MCP
`instructions:` field: a decision loop (observe → decide → act → verify),
tool-selection rules (AX-first / vision-fallback / tray), click-result signal
interpretation (`method`/`verified`), task playbooks, and an error-recovery
reference.

Install it for your agent runtime with the [`skills` CLI](https://www.npmjs.com/package/skills):

```bash
# Codex
npx skills add ucu-mcp -g -a codex --skill ucu-mcp -y
# Claude Code
npx skills add ucu-mcp -g -a claude-code --skill ucu-mcp -y
```

Or reference it directly: the entry point is
[`skills/ucu-mcp/SKILL.md`](skills/ucu-mcp/SKILL.md), with deeper content in
`skills/ucu-mcp/references/` (tool reference, workflows, troubleshooting).

## Safety

### Built-in safety rules

1. **Key blocklist**: Dangerous shortcuts are blocked
   - macOS: `Cmd+Q`, `Cmd+W`, `Cmd+L`, `Cmd+Option+Esc`, `Cmd+Ctrl+Power`
   - Windows/Linux: `Alt+F4`, `Ctrl+Alt+Del`, `Ctrl+Alt+Backspace`

2. **Window skip list**: Sensitive windows are skipped
   - Password managers: 1Password, Bitwarden, LastPass, KeePass, Dashlane
   - Banking apps: windows containing "bank", "paypal"
   - System tools: Keychain Access

3. **Rate limiting**: Minimum 100ms between actions (prevents runaway loops)

### Configuration via environment variables

```bash
export UCU_RATE_LIMIT_MS=100      # Minimum action interval in ms
export UCU_LOG_LEVEL=info          # debug, info, warn, error
export UCU_DRY_RUN=1               # Dry-run mode (no real actions executed)
```

### Custom safety config

Create `safety.json`:

```json
{
  "blockedKeys": ["cmd+shift+q"],
  "skippedWindows": ["My Sensitive App"],
  "rateLimitMs": 100
}
```

Then point to it:

```bash
export UCU_SAFETY_CONFIG=/path/to/safety.json
```

## Architecture

```
src/
├── mcp/                    # MCP protocol layer
│   ├── server.ts           # MCP server
│   ├── tools.ts            # Tool registration and dispatch
│   └── transport.ts        # Transport (stdio)
│
├── platform/               # Platform abstraction layer
│   ├── base.ts             # Platform interface
│   └── macos.ts            # macOS (AX API)
│
├── safety/                 # Safety subsystem
│   ├── guard.ts            # Safety guard (rule pipeline)
│   └── permissions.ts      # Permission checks
│
├── utils/                  # Platform utilities
│   ├── screenshot.ts       # Screenshot capture
│   └── input.ts            # Input synthesis
│
└── util/                   # General utilities
    ├── errors.ts           # Error types
    ├── logger.ts           # Structured logging
    └── retry.ts            # Retry logic
```

## Error Handling

Tool execution failures return standard MCP tool results with `isError: true`. The first content item is JSON text so clients can make policy decisions without string matching:

```json
{
  "error": {
    "name": "WindowNotFoundError",
    "code": "WINDOW_NOT_FOUND",
    "retryable": false,
    "message": "Window win-1 not found. It may have been closed. Run list_windows to get fresh IDs.",
    "recovery": "Run list_windows again, then retry with a fresh windowId or omit windowId for screen coordinates."
  }
}
```

| Error Code | Description | Retryable |
|------------|-------------|-----------|
| `PLATFORM_ERROR` | Platform API call failed | Yes |
| `PERMISSION_DENIED` | Missing system permission | No |
| `SAFETY_BLOCKED` | Blocked by safety rule | No |
| `WINDOW_NOT_FOUND` | Window does not exist | No |
| `ELEMENT_NOT_FOUND` | Accessibility element is stale or missing | No |
| `UNSUPPORTED_PARAMETER` | Valid JSON requested an unsupported parameter combination | No |
| `COORDINATE_OUT_OF_BOUNDS` | Coordinate outside screen | No |
| `INPUT_FAILED` | Input synthesis failed | Yes |
| `CAPTURE_FAILED` | Screenshot/OCR capture failed | Yes |
| `UNKNOWN_ERROR` | Unexpected internal failure | No |

## Development

```bash
git clone https://github.com/kaguya/ucu-mcp.git
cd ucu-mcp
npm install
npm run build
npm test
```

macOS GUI smoke tests are gated because they open and edit a temporary TextEdit document:

```bash
npm run test:macos-gui
```

## License

MIT
