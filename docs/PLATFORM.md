# UCU-MCP Platform Adapter System

The UCU-MCP platform adapter system provides a unified interface for desktop automation across operating systems. Each OS gets a concrete class that implements the `Platform` interface, and the runtime auto-selects the correct adapter based on `process.platform`.

---

## Platform Interface (`base.ts`)

All platform adapters implement the `Platform` interface defined in `src/platform/base.ts`. The interface is organized into four capability groups.

### Supporting Types

```typescript
interface ScreenRegion { x: number; y: number; width: number; height: number }
interface ScreenSize   { width: number; height: number }
interface CursorPosition { x: number; y: number }

interface WindowInfo {
  id: string;
  title: string;
  processName: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
  isOnScreen: boolean;
}

interface ElementInfo {
  role: string;
  name: string;
  description?: string;
  value?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: ElementInfo[];
  states: string[];
}

interface WindowState {
  window: WindowInfo;
  focusedElement?: ElementInfo;
  tree?: ElementInfo;
}

interface FindElementOptions {
  text?: string;
  role?: string;
  app?: string;
  depth?: number;
  includeBounds?: boolean;
  maxResults?: number;
}
```

### Platform Interface Methods

| Group | Method | Signature |
|---|---|---|
| **Screenshot** | `screenshot` | `(display?: number, region?: ScreenRegion) => Promise<Buffer>` |
| **Screen Info** | `getScreenSize` | `(display?: number) => ScreenSize` |
| **Window Mgmt** | `listWindows` | `(includeMinimized?: boolean) => Promise<WindowInfo[]>` |
| **Window Mgmt** | `getWindowState` | `(windowId?: string, depth?: number, includeBounds?: boolean) => Promise<WindowState>` |
| **Mouse** | `click` | `(x, y, button?, doubleClick?) => Promise<void>` |
| **Mouse** | `move` | `(x, y) => Promise<void>` |
| **Mouse** | `drag` | `(startX, startY, endX, endY, button?) => Promise<void>` |
| **Mouse** | `scroll` | `(x, y, deltaX, deltaY) => Promise<void>` |
| **Cursor** | `getCursorPosition` | `() => CursorPosition` |
| **Keyboard** | `type` | `(text, delay?) => Promise<void>` |
| **Keyboard** | `key` | `(keys: string[]) => Promise<void>` |
| **Accessibility** | `findElement` | `(options: FindElementOptions) => Promise<FindElementResult[]>` |

Mouse `button` accepts `"left" | "right" | "middle"` (default `"left"`). The `key` method takes an array of key names where modifiers like `"command"`, `"control"`, `"alt"`, `"shift"` are combined with a main key to form shortcuts. `getWindowState` may omit `windowId` when a prior `focus_app` target exists, and `includeBounds=false` omits bounds from tree elements and `focusedElement` to reduce AX query cost. `findElement` also supports `includeBounds=false` and `maxResults` for fast discovery on large accessibility trees.

---

## How to Implement a New Platform Adapter

1. **Create the class file** at `src/platform/<os>.ts` that imports and implements `Platform` from `base.ts`.

2. **Implement every method** on the interface. For methods you cannot yet support, throw a descriptive error (e.g. `throw new Error("Not implemented: <OS> <method>")`) rather than silently returning empty data, so callers can distinguish "not implemented" from "no results."

3. **Register in the factory** by adding a `case` branch to the `getPlatform()` function in `src/mcp/tools.ts`:
   ```typescript
   case "freebsd":
     _platform = new FreeBSDPlatform();
     _platformType = "freebsd";
     break;
   ```

4. **Add utility dispatch** if your OS needs new shell commands. The utility modules (`screenshot.ts`, `input.ts`) each contain a private `getPlatform()` that returns `"darwin" | "linux" | "win32"`. Extend that union and add a `case` branch in every `switch` inside those modules.

5. **Handle permissions**. Each OS has different accessibility/input permissions. Document what the user must grant (e.g. macOS Accessibility, Linux udev rules) and ensure `src/safety/permissions.ts` covers the new platform.

6. **Test**. Add integration tests under `tests/` that gate on `process.platform` so they only run on the target OS.

---

## macOS Implementation (`macos.ts`)

The macOS adapter is the most complete implementation. It relies on two primary mechanisms:

### JXA (JavaScript for Automation)

JXA scripts are executed via `osascript -l JavaScript` and have access to the Objective-C bridge (`ObjC.import`). This is used for:

- **Screen size** -- `$.NSScreen.mainScreen.frame` via AppKit.
- **Cursor position** -- `CGEventGetLocation()` via CoreGraphics.
- **Mouse move** -- `CGEventCreateMouseEvent` with `kCGEventMouseMoved`.
- **Scroll** -- `CGEventCreateScrollWheelEvent` via CoreGraphics.
- **Drag** -- Sequence of `CGEventCreateMouseEvent` calls: `kCGEventLeftMouseDown`, `kCGEventLeftMouseDragged`, `kCGEventLeftMouseUp`.
- **Window listing** -- `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)` via CoreGraphics, returning JSON with window number, owner name, PID, bounds, and on-screen state.
- **Window state** -- `Application('System Events')` queries the target process/window accessibility tree and independently summarizes the focused UI element when it belongs to the requested window.

### AppleScript (System Events)

AppleScript is used where JXA is unnecessary or less convenient:

- **Click / double-click / right-click** -- `tell application "System Events" to [right] click at {x, y}`.
- **Keyboard typing** -- `tell application "System Events" to keystroke "<text>"` with optional `using {command down, shift down, ...}` for modifiers.

### Screenshot

Delegated to `src/utils/screenshot.ts` which calls the native `screencapture` CLI:
- Full screen: `screencapture -x <outfile>`
- Region: `screencapture -x -R<x,y,w,h> <outfile>`
- Window: `screencapture -x -l<windowId> <outfile>`

### Input

Delegated to `src/utils/input.ts` which creates `MouseAction` and `KeyboardAction` objects. On macOS these use `osascript` for mouse actions and `osascript -e` for keyboard actions, with key-name mapping via `OSASCRIPT_KEY_MAP`.

### Permissions Required

- **Accessibility** -- System Preferences > Privacy & Security > Accessibility. Required for System Events to synthesize input and read the accessibility tree.
- **Screen Recording** -- Required for `screencapture` to capture other applications' windows on macOS 10.15+.

---

## Windows Implementation (`windows.ts`)

**Status: Stub.** The `WindowsPlatform` class exists and implements the `Platform` interface, but every method throws `"Not implemented"` or returns placeholder data.

### Current State

- `getScreenSize` returns a hardcoded `{ width: 1920, height: 1080 }`.
- `getCursorPosition` returns `{ x: 0, y: 0 }`.
- All other methods throw `Error("Not implemented: Windows <method>")`.

### Planned Approach

The utility modules (`screenshot.ts`, `input.ts`) already contain Windows code paths using PowerShell, which provides a starting point:

- **Screenshots** -- `System.Drawing.Graphics.CopyFromScreen` via PowerShell. The `captureFullScreen`, `captureRegion`, and `captureWindow` functions already have working PowerShell implementations that create a `Bitmap`, call `CopyFromScreen`, and save to a temp file.
- **Mouse input** -- `user32.dll` P/Invoke via PowerShell: `SetCursorPos` for move, `mouse_event` flags (`0x0002`/`0x0004` for left down/up, `0x0008`/`0x0010` for right down/up, `0x0800` for wheel) for click, double-click, right-click, scroll, and drag.
- **Keyboard input** -- `System.Windows.Forms.SendKeys` via PowerShell. Modifier encoding: `^` = Ctrl, `%` = Alt, `+` = Shift. Key names mapped via `SENDKEYS_MAP`.
- **Window listing** -- `EnumWindows` + `GetWindowText` via `ffi-napi` or `edge-js` for native Win32 API calls.
- **Window state / accessibility tree** -- UI Automation API (COM-based), accessible via PowerShell or a Node native addon.

### Dependencies to Add

- `ffi-napi` or `edge-js` for calling Win32 APIs from Node.js.
- PowerShell 5.1+ (pre-installed on Windows 10/11).

---

## Linux Implementation (`linux.ts`)

**Status: Stub.** The `LinuxPlatform` class exists with method signatures and TODO comments, but every method throws `"Linux adapter not yet implemented"`.

### Current State

- `listWindows` returns an empty array (does not throw).
- All other methods throw `Error("Linux adapter not yet implemented")`.

### Planned Approach

The utility modules already contain Linux code paths:

- **Screenshots** -- `scrot` for full-screen capture, `import` (ImageMagick) for region capture, `xwd` + `convert` for window capture.
- **Mouse input** -- `xdotool`: `mousemove`, `click` (button 1/2/3), `mousedown`/`mouseup`/`mousemove` for drag, buttons 4/5 for scroll.
- **Keyboard input** -- `xdotool type` for text, `xdotool key` for key presses and combos (e.g. `ctrl+c`, `super+l`). Key names mapped via `XDOTOOL_KEY_MAP`.
- **Window listing** -- `wmctrl -l` or `xdotool search` to enumerate windows.
- **Window state / accessibility tree** -- AT-SPI2 via D-Bus. This is the Linux accessibility standard (used by Orca, GNOME accessibility). Requires D-Bus bindings for Node.js.

### X11 vs Wayland

The current utility code targets X11 tools (`xdotool`, `scrot`, `import`, `xwd`). Wayland requires different tooling:

- **Screenshots** -- `grim` (Wayland screenshot tool) instead of `scrot`.
- **Input** -- `ydotool` (works on both X11 and Wayland via uinput) instead of `xdotool`.
- **Window management** -- `wlr-randr` for screen info, `swaymsg` for Sway/i3 window listing.

A production Linux adapter should detect the display server and dispatch accordingly.

### Dependencies to Add

- `xdotool` (X11) or `ydotool` (Wayland) for input synthesis.
- `scrot` (X11) or `grim` (Wayland) for screenshots.
- `wmctrl` for window listing.
- AT-SPI2 D-Bus bindings for accessibility tree access.

---

## Platform Detection and Auto-Selection

Platform selection happens in `src/mcp/tools.ts` via a singleton factory:

```typescript
let _platform: Platform | undefined;

function getPlatform(): Platform {
  if (_platform) return _platform;
  switch (process.platform) {
    case "darwin":
      _platform = new MacOSPlatform();
      break;
    case "win32":
      _platform = new WindowsPlatform();
      break;
    case "linux":
      _platform = new LinuxPlatform();
      break;
    default:
      throw new PlatformError(`Unsupported platform: ${process.platform}`);
  }
  return _platform;
}
```

Key properties of this design:

- **Lazy initialization** -- The platform instance is created on first access, not at import time.
- **Singleton** -- Once created, the same instance is reused for all subsequent tool calls.
- **No manual configuration** -- The user never specifies which platform to use; `process.platform` is the sole authority.
- **Fail-fast on unknown platforms** -- Unsupported OS values throw `PlatformError` immediately rather than falling back to a broken adapter.

The utility modules (`screenshot.ts`, `input.ts`) each maintain their own private `getPlatform()` function that returns `"darwin" | "linux" | "win32"` and throws on anything else. These are independent of the main factory and are used for dispatching within the utility code.

---

## Utility Functions

### `src/utils/screenshot.ts`

Provides three capture functions, all returning base64-encoded PNG strings. Each writes to a temp file, reads it, then deletes the file.

| Function | Purpose | macOS CLI | Linux CLI | Windows CLI |
|---|---|---|---|---|
| `captureFullScreen()` | Entire screen | `screencapture -x` | `scrot` | PowerShell `CopyFromScreen` |
| `captureWindow(windowId)` | Specific window | `screencapture -l<id>` | `xwd` + `convert` | PowerShell P/Invoke `GetWindowRect` + `CopyFromScreen` |
| `captureRegion(x, y, w, h)` | Screen rectangle | `screencapture -R<x,y,w,h>` | `import -window root -crop` | PowerShell `CopyFromScreen` |

Temp files are created in `os.tmpdir()` with the pattern `ucu-screenshot-<timestamp>-<random>.png`. The `readAndClean` helper reads the file to a base64 string and deletes it, swallowing unlink errors.

### `src/utils/input.ts`

Provides two factory functions that return action objects with platform-internal dispatch.

#### `createMouseAction(): MouseAction`

Returns an object with `click`, `doubleClick`, `rightClick`, `scroll`, and `drag` methods. Each method contains a `switch` on the detected platform:

| Action | macOS | Linux | Windows |
|---|---|---|---|
| `click` | `osascript` System Events click | `xdotool mousemove + click` | PowerShell `SetCursorPos` + `mouse_event` |
| `doubleClick` | `osascript` double click | `xdotool click --repeat 2` | PowerShell two rapid `mouse_event` pairs |
| `rightClick` | `osascript` right click | `xdotool click 3` | PowerShell `mouse_event 0x0008/0x0010` |
| `scroll` | JXA `CGEventCreateScrollWheelEvent` | `xdotool click 4/5` | PowerShell `mouse_event 0x0800` with delta |
| `drag` | JXA `CGEventCreateMouseEvent` sequence | `xdotool mousedown + mousemove + mouseup` | PowerShell `SetCursorPos` + `mouse_event` with sleep |

#### `createKeyboardAction(): KeyboardAction`

Returns an object with `typeText`, `pressKey`, and `pressShortcut` methods. Key names are normalized through platform-specific maps:

| Map | Target | Example Mappings |
|---|---|---|
| `OSASCRIPT_KEY_MAP` | macOS AppleScript | `enter` -> `"return"`, `backspace` -> `"delete"`, `up` -> `"up arrow"` |
| `XDOTOOL_KEY_MAP` | Linux xdotool | `enter` -> `"Return"`, `backspace` -> `"BackSpace"`, `pageup` -> `"Page_Up"` |
| `SENDKEYS_MAP` | Windows SendKeys | `enter` -> `"{ENTER}"`, `escape` -> `"{ESC}"`, `pagedown` -> `"{PGDN}"` |

Modifier key handling in `pressShortcut`:

- **macOS** -- AppleScript `using {command down, control down, ...}` syntax. `"command"` and `"cmd"` both map to `command down`.
- **Linux** -- xdotool `key` combo format: `ctrl+c`, `super+l`. `"command"`, `"cmd"`, and `"super"` all map to `super`.
- **Windows** -- SendKeys modifier prefixes: `^` = Ctrl, `%` = Alt, `+` = Shift. No Windows key support via SendKeys.

The `typeText` method supports an optional `delay` parameter (milliseconds between keystrokes). On macOS this loops character-by-character with `setTimeout`; on Linux it passes `--delay` to `xdotool type`; on Windows it types the entire string at once (no delay support).
