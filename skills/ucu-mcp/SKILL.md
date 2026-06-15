---
name: ucu-mcp
description: >-
  Guidance for using UCU-MCP, the macOS computer-use MCP server (screenshot,
  click, type, OCR, AX element tools, menu-bar tray support). Use when an
  agent needs to automate macOS desktop apps over MCP — establishing target
  context, reading screen state, interacting with UI elements, operating
  menu-bar/tray apps, or recovering from AX/permission errors. Covers Claude
  Code CLI/Desktop, Codex, OpenCode, and other MCP clients.
---

# UCU-MCP

UCU-MCP is a cross-client computer-use MCP server for macOS (Windows/Linux are
explicit stubs). It exposes 26 tools that let an agent see the screen and drive
native apps through a combination of Accessibility (AX) APIs, CGEvent input
synthesis, Vision OCR, and ScreenCaptureKit screenshots.

- npm package: `ucu-mcp`
- Run: `npx -y ucu-mcp` (stdio MCP server) or install globally via `npm i -g ucu-mcp`

## Core Workflow

1. **Check readiness** → `doctor` verifies Accessibility + Screen Recording
   permissions and native helpers. If anything is missing, follow its guidance
   (see [troubleshooting](references/troubleshooting.md)).
2. **Establish target context** → `list_apps` then `focus_app(name)` sets the
   active window target. Subsequent AX tools operate against that target.
3. **Prefer AX over coordinates** → `find_element(text/role/value)` →
   `click_element` / `type_in_element` / `set_value`. AX is precise and survives
   layout shifts; coordinates are a last resort.
4. **When AX is opaque (Electron/Tauri/WebView)** → `screenshot` + `ocr` to
   locate text by bounding box, then `click(x, y)` at the returned coordinates.
5. **When image content is not visible to you** (relayed/downgraded to a URL) →
   `screenshot(describe: true)` or the standalone `describe_screen` tool to get a
   structured text view (OCR blocks + AX tree + foreground window).
6. **Menu-bar/tray apps** (e.g. cc-switch) → `click_menu_bar_extra(app,
   description/name/index)` opens the tray menu, then `find_element` inside it.
7. **Verify actions** → pass `captureAfter: true` on action tools, or call
   `screenshot` / `get_window_state` afterwards.
8. **Recover from errors** → every error response carries a `hint` with the
   next step. See the [error code table](references/troubleshooting.md).

Full tool inventory with parameters: [tool-reference](references/tool-reference.md).
Common task playbooks: [workflows](references/workflows.md).

## Operating Rules

- **AX-first.** Use `find_element` → `click_element` / `type_in_element` /
  `set_value` whenever the AX tree exposes the target. Fall back to coordinates
  only when AX returns nothing (Electron/WebView) or the control silently
  swallows AX actions.
- **Observe before acting.** Call `screenshot` / `get_window_state` /
  `describe_screen` before destructive or hard-to-reverse actions so you act on
  current state, not assumptions.
- **TARGET_STALE is recoverable.** Re-run `focus_app` for the target app, then
  retry — the element cache refetches equivalent AX nodes.
- **Tray apps need `click_menu_bar_extra`.** `focus_app` alone cannot reach
  pure menu-bar (LSUIElement) apps; their status item is hosted by
  `SystemUIServer` and is not in any app window's AX tree.
- **Dangerous actions are blocked.** Quit/logout/lock shortcuts (`cmd+q`,
  `cmd+shift+q`, `cmd+l`, …), sensitive-window URLs, and suspicious injected
  text are rejected by the safety guard. Choose a safer action or ask the user.
- **Sensitive fields are masked in `describe_screen`.** Password fields
  (`AXSecureTextField`, or names matching `/password|secret|token/i`) appear as
  `[REDACTED]` — never try to read or exfiltrate them.
- **macOS is locked → actions blocked.** The server refuses to synthesize input
  while the screen is locked; wait for unlock or ask the user.

## MCP Config

Add UCU-MCP to your MCP client. Stdio transport, no arguments needed.

**Codex / generic TOML:**

```toml
[mcp_servers.ucu-mcp]
command = "npx"
args = ["-y", "ucu-mcp"]
```

**Claude Code CLI / Desktop** — add via `claude mcp add`:

```bash
claude mcp add ucu-mcp -- npx -y ucu-mcp
```

Run `ucu-mcp doctor` once after first connect to verify macOS permissions
(System Settings → Privacy & Security → Accessibility **and** Screen Recording
must be granted to the launching terminal/client).

## References

- [tool-reference.md](references/tool-reference.md) — all 26 tools, parameters,
  return shapes, and when to use each.
- [workflows.md](references/workflows.md) — playbooks for common tasks: form
  filling, tray apps, opaque Electron UIs, vision-degraded environments, stale
  targets.
- [troubleshooting.md](references/troubleshooting.md) — error code table with
  recovery steps, permission issues, AX-opacity workarounds, OCR failures.
