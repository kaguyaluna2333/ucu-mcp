---
name: ucu-mcp
description: >-
  Guidance for using UCU-MCP, the macOS computer-use MCP server (screenshot,
  click, type, OCR, AX element tools, menu-bar tray support). Use when an
  agent needs to automate macOS desktop apps over MCP — establishing target
  context, reading screen state, interacting with UI elements, operating
  menu-bar/tray apps, or recovering from AX/permission errors. Designed for
  CLI agents (Claude Code, Codex, OpenCode) that connect via stdio MCP and
  drive the desktop one tool call at a time.
---

# UCU-MCP

UCU-MCP is a macOS computer-use MCP server for CLI agents. It exposes 26 tools
that let you see the screen and drive native apps through Accessibility (AX)
APIs, CGEvent input synthesis, Vision OCR, and ScreenCaptureKit screenshots.
Windows/Linux are explicit stubs.

- npm: `ucu-mcp` · run: `npx -y ucu-mcp` (stdio MCP server)
- You are a **CLI agent**: each tool call is one MCP request over stdio. There
  is no persistent UI session between calls — **always re-observe state before
  acting**, because the user or the app may have changed the screen since your
  last call.

## The Decision Loop (run this for every action)

Think in cycles of **observe → decide → act → verify**. Do not chain actions
blindly; the desktop is a moving target.

```
┌─────────────────────────────────────────────────────────────┐
│  OBSERVE: what's on screen / what's focused right now?      │
│    screenshot{}  ·  describe_screen{}  ·  get_window_state{} │
├─────────────────────────────────────────────────────────────┤
│  DECIDE: AX-first, coordinates only as fallback              │
│    AX tree exposes target? → find_element → element tools   │
│    AX opaque (Electron/Tauri)? → ocr → click(x,y)           │
│    Tray-only app? → click_menu_bar_extra                    │
├─────────────────────────────────────────────────────────────┤
│  ACT: click_element / type_in_element / set_value / click   │
│    Pass captureAfter:true to get a screenshot in the reply  │
├─────────────────────────────────────────────────────────────┤
│  VERIFY: did it work? (see "Reading click results" below)   │
│    result.verified === true   → proceed                     │
│    result.verified === false  → screenshot/get_window_state │
│    result.method === "coordinate" → re-observe, may be off  │
└─────────────────────────────────────────────────────────────┘
```

## Reading click results (v0.5.1+)

`click_element` and `click_menu_bar_extra` return a `result` object with
`method` and `verified` fields. **Read them every time** — they tell you
whether your click actually landed:

| `method` | `verified` | Meaning | What you do |
|---|---|---|---|
| `"axpress"` | `true` | AXPress changed observable state (value/focused/selected) | Proceed — high confidence it worked |
| `"axpress"` | `false` | AXPress ran but element had no observable state to verify (e.g. plain button) | Verify via `screenshot` or `get_window_state` |
| `"coordinate"` | `false` | AXPress was silently swallowed (Tauri/Electron) OR threw; fell back to coordinate click | **Always re-observe** — coordinate clicks can miss, or the app may need a second click |

A `warnings[]` array in the receipt explains the fallback. Never assume a
coordinate-fallback click succeeded without checking.

## Tool selection — AX vs vision vs tray

**AX-first** (precise, survives layout shifts):
`find_element` → `click_element` / `type_in_element` / `set_value`. Use when
the app exposes an AX tree (native macOS apps, most non-Electron apps).

**Vision fallback** (when AX is opaque — Electron/Tauri/WebView return an
empty `AXGroup` or `find_element` returns 0 with an "app is likely Electron"
hint):
`screenshot` → `ocr` → compute click point from the OCR block's bounding box
→ `click(x, y)` at `block.x + block.width/2, block.y + block.height/2`.

**Text-only fallback** (when you cannot see image content blocks — relay
downgrades them to URLs):
`describe_screen` or `screenshot({describe: true})` → structured text with OCR
blocks + AX tree. Password fields are masked to `[REDACTED]`.

**Tray apps** (menu-bar-only / LSUIElement apps like cc-switch — no window, no
AX tree entry):
`focus_app` (falls back to a tray target) → `click_menu_bar_extra` opens the
menu → `find_element` inside the menu, or `screenshot`+`ocr` if the menu is
also opaque.

## First-run setup

1. **Connect the server** to your CLI agent:

   Codex / generic TOML (`.codex/config.toml` or equivalent):
   ```toml
   [mcp_servers.ucu-mcp]
   command = "npx"
   args = ["-y", "ucu-mcp"]
   ```

   Claude Code CLI:
   ```bash
   claude mcp add ucu-mcp -- npx -y ucu-mcp
   ```

2. **Grant macOS permissions** — Accessibility **and** Screen Recording must be
   enabled for your terminal/client in System Settings → Privacy & Security.
   **Restart the client after granting** (changes don't apply to running
   processes).

3. **Verify** — call `doctor`. It reports per-permission status, native helper
   health, and which process to authorize. Green = ready.

## Operating Rules

- **Re-observe before every action.** The screen changes between your calls.
  A `focus_app` from 5 calls ago may be stale; a window may have closed.
- **AX-first, coordinates only as fallback.** AX clicks are precise and
  verifiable; coordinate clicks can drift and are unverifiable.
- **`verified:false` means re-observe.** Never trust an unverifiable click
  without a follow-up `screenshot` or `get_window_state`.
- **TARGET_STALE is recoverable.** Re-run `focus_app` for the target app, then
  retry. `type_in_element` auto-refetches equivalent AX nodes.
- **Dangerous actions are blocked.** `cmd+q`, `cmd+shift+q`, `cmd+l`, `alt+f4`,
  sensitive-window URLs, and suspicious injected text are rejected. Choose a
  safer action or ask the user.
- **macOS locked → all input blocked.** Wait for unlock; there is no bypass.
- **Don't exfiltrate passwords.** `describe_screen` masks them to
  `[REDACTED]`; respect that.

## References

- [tool-reference.md](references/tool-reference.md) — all 26 tools, parameters,
  return shapes, and when to use each.
- [workflows.md](references/workflows.md) — CLI-executable playbooks (form
  filling, tray apps, opaque Electron UIs, vision-degraded environments, stale
  targets, click-result verification).
- [troubleshooting.md](references/troubleshooting.md) — error code table with
  recovery steps, permission issues, AX-opacity workarounds, OCR failures.
