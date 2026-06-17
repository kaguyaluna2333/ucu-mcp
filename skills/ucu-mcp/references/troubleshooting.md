# Troubleshooting

> Before taking risky UI actions (delete, send, pay, change settings), see the
> **Confirmation Policy** in [SKILL.md](../SKILL.md#confirmation-policy).

## First Checks

1. Run `doctor` — verifies Accessibility + Screen Recording permissions and
   native helpers. Most failures are permission issues.
2. Confirm the target app is running and not minimized to the point of having no
   on-screen window: `list_apps` + `list_windows`.
3. Check `errors[]` in `describe_screen` responses — it names which source
   (ocr/ax/foreground/screen) failed and why.

---

## Error Code Table

Every error response carries a `code` and a `hint`. The table below maps codes
to recovery steps (mirrors the runtime `recoveryHint`).

| Code | Meaning | Recovery |
|---|---|---|
| `WINDOW_NOT_FOUND` | The target window does not exist or is not on screen. | `list_windows` again, retry with a fresh `windowId`, or omit `windowId` for screen coordinates. |
| `TARGET_STALE` | The active target window changed pid or closed. | `focus_app` for the target app again, then retry. `type_in_element` auto-refetches equivalent nodes. |
| `ELEMENT_NOT_FOUND` | No AX element matched the selector. | `find_element` again with broader selectors (different `text`, `textMode:"contains"`, drop `role`). If still empty, the app may be Electron-opaque — see below. |
| `PERMISSION_DENIED` | Accessibility or Screen Recording not granted. | Run `doctor`, then grant the missing permission in System Settings → Privacy & Security, and **restart the launching client** (changes do not apply to already-running processes). |
| `SAFETY_BLOCKED` | Action rejected by the safety guard (dangerous shortcut, sensitive window, suspicious text). | Choose a less risky action, or ask the user to perform it manually. Blocked shortcuts include `cmd+q`, `cmd+shift+q`, `cmd+l`, `alt+f4`. |
| `INPUT_FAILED` | Input synthesis (click/type/keypress) failed at the CGEvent layer. | Observe current state with `screenshot` or `get_window_state`, then retry only if safe. |
| `CAPTURE_FAILED` | Screenshot/OCR failed (usually Screen Recording permission). | `doctor` → grant Screen Recording → restart client. |
| `COORDINATE_OUT_OF_BOUNDS` | Click/drag coordinates are outside the active display/window. | `get_screen_size` or `list_windows`, retry with coordinates inside bounds. |
| `UNSUPPORTED_PARAMETER` | A parameter combination is invalid (e.g. `screenshot` with both `windowId` and `region`). | Remove or replace the unsupported parameter; inspect `tools/list` for the schema. |

---

## Click result signals (v0.5.1+)

`click_element` and `click_menu_bar_extra` return `result.method` and
`result.verified`. These are not errors — they tell you how confident to be:

- **`method:"axpress", verified:true`** — AXPress changed observable state.
  Proceed normally.
- **`method:"axpress", verified:false`** — AXPress ran but the element exposed
  no observable state (plain button, no value/focused/selected). It *probably*
  worked, but re-observe with `screenshot`/`get_window_state` to be sure. A
  `warnings[]` entry explains this.
- **`method:"coordinate", verified:false`** — AXPress was silently swallowed
  (Tauri/Electron custom controls) or threw; ucu-mcp fell back to a coordinate
  click at the element's bounds center. **Coordinate clicks can miss** — always
  re-observe. A `warnings[]` entry says "coordinate fallback was used".

This is not a bug — it's the server telling you it couldn't fully confirm the
click. The verify-then-fallback logic exists *because* Tauri/Electron controls
silently swallow AXPress without throwing.

---

---

## Permission Issues

macOS requires two permissions for full functionality:

- **Accessibility** — needed for all AX tools (`find_element`,
  `click_element`, `get_window_state`, `list_windows`, `click_menu_bar_extra`).
- **Screen Recording** — needed for `screenshot`, `ocr`, and `describe_screen`
  (with `ocr: true`).

Grant via **System Settings → Privacy & Security → Accessibility / Screen
Recording**, enabling the entry for the launching terminal/client app (Terminal,
iTerm, Claude Code, Codex, etc.).

**Critical:** permission changes do not apply to already-running processes.
After granting, **quit and restart the client** that launches `ucu-mcp`.

Run `ucu-mcp doctor` (or the `doctor` tool) to verify — it reports per-permission
status and which process to authorize.

---

## Electron / Tauri / WebView AX Opacity

**Symptom:** `find_element` returns 0 results, `get_window_state` returns a near-
empty tree (just an `AXGroup`), `list_windows` shows the window but AX tools
can't see into it.

**Cause:** Electron/Tauri/WebView apps render their UI in a composited layer
that macOS AX cannot introspect. The AX tree exposes only the window frame and
traffic-light buttons.

**Workaround — pixel path:**
```
screenshot({})
ocr({})
  → blocks[].text locates the target UI text with bounding box {x,y,width,height}
click({ x: block.x + block.width/2, y: block.y + block.height/2 })
```

`find_element` and `list_windows` emit a `hint` describing this fallback when
they detect the pattern. For one-shot planning, `describe_screen` gives OCR + AX
together.

---

## Menu-Bar / Tray App Not Reachable

**Symptom:** `focus_app("tray-app")` throws `WINDOW_NOT_FOUND`; the app has no
window in `list_windows`.

**Cause:** Pure menu-bar (LSUIElement) apps have no window; their status item is
hosted by the `SystemUIServer` system process.

**Workaround:**
```
click_menu_bar_extra({ app: "tray-app", name: "TrayApp" })   # opens tray menu
find_element({ text: "Settings", app: "tray-app" })          # menu items are AX-visible
click_element({ elementId })
```

`focus_app` automatically falls back to a tray target when `click_menu_bar_extra`
finds a matching status item, so subsequent AX tools work against the menu.

If the tray menu itself is Electron-opaque:
```
click_menu_bar_extra({ app: "tray-app" })
screenshot({})
ocr({}) → locate menu item by text → click(x, y)
```

---

## OCR Failures

**Symptom:** `ocr` or `describe_screen` reports OCR failure (`ocr.status:
"failed"`), or native OCR helper not found in `doctor`.

**Checks:**
1. Screen Recording permission granted and client restarted.
2. Native helper present — `doctor` reports `ocr` helper status. If missing, the
   npm package may be corrupted; reinstall.
3. Screen is not locked (OCR captures a black frame when locked).

`describe_screen` degrades gracefully — OCR failure still returns AX state, so
you can fall back to `get_window_state` / `find_element`.

---

## describe_screen Returns Empty / All-skipped

**Symptom:** `describe_screen` returns `errors: []` but `ocr.status:
"skipped"` and `ax.status: "skipped"`.

**Cause:** you passed `ocr: false, includeAx: false`, or the params defaulted to
that (note: in live MCP use the SDK applies `ocr: true, includeAx: true`
defaults; if you see both skipped, the client stripped defaults).

**Fix:** explicitly pass `ocr: true, includeAx: true`.

---

## Actions Blocked While macOS Is Locked

**Symptom:** input actions (`click`, `type_text`, `press_key`, …) fail; observe
actions (`screenshot`, `ocr`) return black/empty frames.

**Cause:** the safety guard refuses to synthesize input while the screen is
locked (the user is not present to supervise).

**Fix:** wait for the user to unlock, or ask them to unlock. There is no bypass.
