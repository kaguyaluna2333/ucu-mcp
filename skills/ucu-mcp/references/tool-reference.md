# Tool Reference

UCU-MCP exposes 26 tools across five categories. All action tools accept
optional `captureAfter` / `captureMaxWidth` / `captureFormat` parameters that
screenshot the result and append it to the response.

Coordinate inputs are **screen-absolute** unless noted (window-relative only
when a `windowId` is explicitly passed).

---

## Screen & Window

### `screenshot`
Capture the full screen, a region, or a specific window.

| Param | Type | Default | Notes |
|---|---|---|---|
| `display` | number | 0 | Display index |
| `windowId` | string | — | From `list_windows`; captures that window |
| `region` | `{x,y,width,height}` | — | Mutually exclusive with `windowId` |
| `format` | `"png"` \| `"jpeg"` | `"png"` | |
| `maxWidth` | number | 1280 | Resize preserving aspect ratio |
| `describe` | boolean | false | Append a text `ScreenDescription` block (OCR + AX) after the image |
| `describeOptions` | object | — | `{axDepth=3, ocrBlocks=50, includeAx=true}` when `describe=true` |

Returns one image content block (+ one text block if `describe=true`). Use
`describe=true` when image content may not reach the model (relay/URL downgrade).

### `list_windows`
List visible windows. Returns `WindowInfo[]` (`{id, title, processName, pid,
bounds, isMinimized, isOnScreen}`). When empty, includes a `diagnostics` hint
distinguishing permission-denied vs Electron-opacity.

| Param | Type | Default |
|---|---|---|
| `includeMinimized` | boolean | false |

### `get_window_state`
AX tree of a window. Returns `WindowState` = `{window, focusedElement?, tree?}`.
The `tree` is a depth-limited `ElementInfo` (`{role, name, value, states,
bounds?, children?}`).

| Param | Type | Default |
|---|---|---|
| `windowId` | string | active target |
| `depth` | number | 3 (capped at 10) |
| `includeBounds` | boolean | false |

### `get_screen_size`
Returns `{width, height, scaleFactor, estimated?}`. Synchronous, low-cost.

| Param | Type | Default |
|---|---|---|
| `display` | number | 0 |

### `ocr`
Run Vision OCR on the full screen or a region. Returns `{elements:
OcrElement[], fullText}`. Each `OcrElement` = `{text, x, y, width, height,
confidence}` in screen-absolute coordinates.

| Param | Type | Default |
|---|---|---|
| `display` | number | 0 |
| `region` | `{x,y,width,height}` | full screen |

### `describe_screen`
Structured text description of the screen — the **vision-degraded fallback**.
Returns `ScreenDescription` = `{capturedAt, screen, foregroundWindow,
ocr:{blocks, fullText, status}, ax:{elements?, status, windowId?}, errors[]}`.
Each source is collected independently; failures land in `errors` (never thrown).
Password fields are masked to `[REDACTED]`.

| Param | Type | Default | Notes |
|---|---|---|---|
| `display` | number | 0 | |
| `ocr` | boolean | true | Requires Screen Recording when true |
| `includeAx` | boolean | true | Requires Accessibility when true |
| `axDepth` | number | 3 | Capped at 10 |
| `ocrBlocks` | number | 50 | Max OCR elements returned |
| `windowId` | string | active target | AX traversal target |

Use when: image content blocks are not visible to you; you need
machine-readable layout; you want OCR + AX in one call with graceful failure.

---

## Mouse & Input

All accept `captureAfter` / `captureMaxWidth` / `captureFormat`.

### `click` / `double_click`
Click at screen coordinates. `button` ∈ `left|right|middle`.

| Param | Type |
|---|---|
| `x`, `y` | number |
| `button` | `"left"` \| `"right"` \| `"middle"` |
| `windowId` | string (optional, makes x/y window-relative) |

### `scroll`
| Param | Type | Notes |
|---|---|---|
| `x`, `y` | number | position |
| `deltaX`, `deltaY` | number | negative deltaY = scroll up |

### `drag`
| Param | Type |
|---|---|
| `startX`, `startY`, `endX`, `endY` | number |
| `button` | `"left"` \| `"right"` \| `"middle"` |
| `duration` | number (ms) |

### `move`
Move cursor without clicking. Params: `x`, `y`.

### `get_cursor_position`
Returns `{x, y}`.

---

## Keyboard

### `type_text`
Type a string at the current cursor position (CGEvent background injection).

| Param | Type |
|---|---|
| `text` | string |
| `delay` | number (ms, optional) |

### `press_key`
Press a key combo. Supports special keys, single letters a–z, single digits 0–9.

| Param | Type | Notes |
|---|---|---|
| `key` | string | e.g. `"enter"`, `"m"`, `"5"` |
| `keys` | string[] | alternative to `key` for multi-tap |
| `modifiers` | string[] | `cmd`, `shift`, `alt`/`option`, `ctrl`/`control`, `capslock` |

Blocked combos: `cmd+q`, `cmd+shift+q`, `cmd+option+q`, `cmd+l`, `alt+f4`,
`ctrl+alt+del` (logout/lock).

---

## AX Element Interaction

These operate on the active target's window (set via `focus_app`). Prefer these
over coordinate clicks.

### `find_element`
Find AX elements by text/role/value. Returns `{results: FindElementResult[],
metrics}`. Each result has an `id` for use in the element tools below. When 0
results, includes a hint guiding to `screenshot`+`ocr`+`click(x,y)` (Electron
opacity).

| Param | Type | Default | Notes |
|---|---|---|---|
| `text` | string | — | Match element name/description |
| `role` | string | — | e.g. `AXButton`, `AXTextField` |
| `value` | string | — | Match current value |
| `textMode` | `"contains"` \| `"exact"` \| `"regex"` | `"contains"` | |
| `app` | string | active target | |
| `depth` | number | 5 | |
| `index` | number | — | Return only the Nth match (0-based) |
| `near` | `{x,y}` | — | Sort by ascending distance, closest first |
| `visibleOnly` | boolean | false | |
| `includeBounds` | boolean | false | |

### `click_element`
Click by element `id`. AXPress first; on AX failure falls back to coordinate
click at the element's bounds center (handles Tauri/Electron silent swallows).

| Param | Type |
|---|---|
| `elementId` | string |
| `app` | string (optional) |

### `set_value`
Set an AX element's value directly (no key synthesis). Best for text fields,
checkboxes, sliders.

| Param | Type |
|---|---|
| `elementId` | string |
| `value` | string |
| `app` | string (optional) |

### `type_in_element`
Focus an element and type into it. Refetches an equivalent AX node if the
original `elementId` is stale (UI tree changed).

| Param | Type | Default |
|---|---|---|
| `elementId` | string | |
| `text` | string | |
| `clearFirst` | boolean | false |
| `app` | string | active target |

### `click_menu_bar_extra`
Click a menu-bar status item (tray icon) — for menu-bar-only apps (e.g.
cc-switch) that `focus_app` cannot target. After clicking, the menu opens; use
`find_element` to locate menu items, or `screenshot` + `ocr` if the menu's AX
tree is opaque.

| Param | Type | Notes |
|---|---|---|
| `app` | string | Target app name |
| `description` | string | Match by description/name substring |
| `name` | string | Match by name/description substring |
| `index` | number | 0-based among matched items |

---

## Runtime & Synchronization

### `list_apps`
Returns `AppInfo[]` = `{name, pid, isFrontmost, windowCount}`. Background-only
processes are filtered.

### `focus_app`
Set the active target context. Establishes a window for AX tools; falls back to
a tray target (`windowId: "tray"`) for menu-bar-only apps if
`click_menu_bar_extra` status items are found.

| Param | Type |
|---|---|
| `app` | string |

### `wait`
Pause execution.

| Param | Type |
|---|---|
| `ms` | number (1–60000) |

### `wait_for_element`
Poll until an AX element matches. Returns the match or times out.

| Param | Type | Default |
|---|---|---|
| `text` / `role` / `value` | string | — |
| `app` | string | active target |
| `until` | `"appear"` \| `"disappear"` \| `"value_change"` | `"appear"` |
| `timeout` / `timeoutMs` | number (ms) | 5000 |
| `interval` / `intervalMs` | number (ms) | 500 |

### `doctor`
Verify permissions, native helpers, and client readiness. Returns a JSON report
with `platform`, `safety`, `nativeHelpers`, `clients`, and `recommendations`.
Run this first when something is misbehaving.

### `clipboard_read` / `clipboard_write`
Read/write the system clipboard. `clipboard_write` text-injection patterns
(e.g. shell-escape sequences) are blocked by the safety guard.
