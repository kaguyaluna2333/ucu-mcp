# Workflows

CLI-executable playbooks. Each is a sequence of tool calls you make one at a
time, reading each response before the next. Coordinates are screen-absolute
unless noted.

---

## 0. Common Mistakes (AVOID THESE)

### ❌ Mistake 1: Clicking without focus_app → cursor jumps, foreground stolen
```
# WRONG — cursor will jump to (100,200) and steal foreground from the user
click({ x: 100, y: 200 })

# RIGHT — per-process posting, no cursor move
focus_app({ app: "Safari" })
click({ x: 100, y: 200 })    → dispatch: "per-pid" ✓
```

### ❌ Mistake 2: Using click_menu_bar_extra for normal app UI
`click_menu_bar_extra` clicks the **macOS system menu bar** (Apple/File/Edit
menu), NOT the app's window UI. It is ONLY for tray-only apps (cc-switch,
Dropbox) that have no window.
```
# WRONG — clicks Apple menu bar, not the app's UI button
click_menu_bar_extra({ app: "Safari" })

# RIGHT — use AX or vision to click the app's actual UI
find_element({ text: "Reload", app: "Safari" })
click_element({ elementId })
```

### ❌ Mistake 3: Falling back to menu bar when AX returns 0
When `find_element` returns 0 (Electron/Tauri), do NOT switch to
`click_menu_bar_extra`. Switch to **vision** (screenshot + ocr + click).
```
# WRONG — find_element returns 0 → clicks Apple menu (useless)
click_menu_bar_extra({ app: "VS Code" })

# RIGHT — find_element returns 0 → OCR the screen → click at text coordinates
screenshot({})
ocr({})
click({ x: block.x + block.width/2, y: block.y + block.height/2 })
```

---

## 1. Fill a form field (native app, AX-visible)

```
# 1. establish target
list_apps({})
focus_app({ app: "Safari" })

# 2. locate the field via AX
find_element({ text: "Email", role: "AXTextField", app: "Safari" })
# → response.result.results[0].id  e.g. "Safari/w0/42"

# 3. type into it
type_in_element({ elementId: "Safari/w0/42", text: "user@example.com" })

# 4. verify (captureAfter returns a screenshot in the same reply)
type_in_element({ elementId: "Safari/w0/42", text: "...", captureAfter: true })
```

**If `find_element` returns 0** with an "app is likely Electron" hint → switch
to workflow #3 (vision fallback).

**If `type_in_element` throws TARGET_STALE** → `focus_app("Safari")` then retry
(it auto-refetches equivalent AX nodes).

---

## 2. Operate a menu-bar / tray app (e.g. cc-switch)

Tray-only apps (LSUIElement) have no window; their status item is hosted by
`SystemUIServer`. `focus_app` alone returns `WINDOW_NOT_FOUND` unless ucu-mcp
finds a tray status item and falls back to a tray target.

```
# 1. establish tray target (returns windowId:"tray" on success)
focus_app({ app: "cc-switch" })

# 2. open the tray menu — check result.verified!
click_menu_bar_extra({ app: "cc-switch", name: "switch" })
# → result: { clicked: true, method: "axpress", verified: true|false }

# 3a. IF the menu exposes AX items, find and click them:
find_element({ text: "Settings", app: "cc-switch" })
click_element({ elementId: "..." })

# 3b. IF find_element returns 0 (menu is also opaque), use vision:
screenshot({})
ocr({})
# → find the menu item text in ocr.blocks, compute center, click:
click({ x: block.x + block.width/2, y: block.y + block.height/2 })
```

**Known gotcha (cc-switch and similar Tauri tray apps):** `click_menu_bar_extra`
may open the app's **native application menu** (About / Hide / Quit) rather than
a custom tray popup. If OCR shows only About/Hide/Quit, the app's real settings
live in a **WebView window** — you need to open that window first (via a menu
item, or `focus_app` once a window exists), then drive it with workflow #3
(Electron-opaque). Don't keep clicking the tray expecting a custom menu.

**If `click_menu_bar_extra` returns `method:"coordinate"`** (AXPress was
swallowed) → re-observe with `screenshot` to confirm the menu actually opened
before searching its contents.

---

## 3. Electron / Tauri / WebView opaque UI

Electron/Tauri apps render UI in a composited layer AX cannot introspect.
`find_element` returns 0; `get_window_state` shows a near-empty `AXGroup`;
`list_windows` emits an Electron hint.

```
# 1. confirm opacity (optional — the hint in the error tells you)
find_element({ text: "Submit" })
# → 0 results, hint: "...likely Electron... screenshot → ocr → click(x,y)"

# 2. see the screen via OCR (text + bounding boxes)
screenshot({})              # for yourself, if you can see images
ocr({})                     # → blocks[].text with {x, y, width, height}

# 3. locate target text, compute click center, click by coordinate
#    (OCR coordinates are screen-absolute)
click({ x: block.x + block.width/2, y: block.y + block.height/2 })

# 4. verify the coordinate click landed (coordinate clicks are unverifiable)
screenshot({})  # or describe_screen({}) if you can't see images
```

For multi-step interaction with a known-opaque app, call `describe_screen` once
to plan, then drive by coordinates. Keep re-OCR-ing between steps — WebView
layouts shift.

---

## 4. Vision-degraded environment (you can't see image content)

When `screenshot` image blocks are downgraded to URLs you cannot fetch, switch
to text-based screen reading:

```
describe_screen({ ocr: true, includeAx: true })
# → { capturedAt, screen, foregroundWindow, ocr:{blocks, status}, ax:{elements, status}, errors }

# OCR blocks give you text + screen coordinates — drive by click(x,y)
# AX elements give you a tree you can find_element/click_element on
```

`describe_screen` **never throws** — OCR and AX each try/catch independently.
Check `errors[]` to see what was skipped/failed, and `ocr.status` / `ax.status`
(`"ok"` / `"skipped"` / `"failed"`). If OCR failed, fall back to AX-only
(`includeAx: true, ocr: false`); if AX failed, fall back to OCR-only.

`screenshot({ describe: true })` returns both an image (for clients that can
see it) **and** a text description block — use this when you're unsure whether
your client renders images.

---

## 5. Recover from TARGET_STALE

The active window target goes stale when the window closes, the app restarts,
or the pid changes. AX tools throw `TARGET_STALE` (receipt includes a `hint`).

```
# 1. re-establish the target
focus_app({ app: "Safari" })

# 2. retry — element cache refetches equivalent AX nodes
find_element({ text: "Save" })
click_element({ elementId: "..." })
```

`type_in_element` auto-refetches an equivalent AX node if the `elementId` is
stale, so a single retry often succeeds without re-running `focus_app`.

---

## 6. Verify a click succeeded (v0.5.1+)

Every `click_element` / `click_menu_bar_extra` response includes `result.method`
and `result.verified`. Use them to decide whether to trust the click:

```
click_element({ elementId: "btn1" })
# → result: { clicked: true, method: "axpress", verified: true }
#   ✓ AXPress changed observable state — proceed with confidence

# OR
# → result: { clicked: true, method: "coordinate", verified: false }
#   warnings: ["AXPress produced no observable state change...coordinate fallback..."]
#   ⚠ MUST re-observe — coordinate clicks can miss or hit the wrong spot:
screenshot({})            # see where you are now
# or
get_window_state({})      # check AX state changed as expected
# or
wait_for_element({ text: "Success", until: "appear", timeout: 3000 })
```

**Rule: `verified:false` always triggers a follow-up observation.** Do not chain
another action on top of an unverifiable click.

---

## 7. Multi-step task with full loop

A realistic CLI sequence with observe → decide → act → verify at each step:

```
# setup
doctor({})                         # permissions + helpers green?
list_apps({})
focus_app({ app: "Notes" })

# step 1: find and click "New Note"
find_element({ text: "New Note" })        # → id "Notes/w0/3"
click_element({ elementId: "Notes/w0/3", captureAfter: true })
# read result.verified; if false → screenshot to confirm a new note opened

# step 2: if ELEMENT_NOT_FOUND (UI shifted), refetch
find_element({ text: "New Note" })        # → id2 (may differ)
click_element({ elementId: id2 })

# step 3: type into the new note body
find_element({ role: "AXTextArea" })      # → bodyId
type_in_element({ elementId: bodyId, text: "Hello", captureAfter: true })

# step 4: confirm
screenshot({})                            # or describe_screen({}) if vision-degraded
```

---

## 8. When you're stuck — diagnostic order

If tools keep failing and you don't know why:

1. `doctor({})` — permissions/helpers still green? (Screen may have re-locked.)
2. `list_apps({})` + `list_windows({})` — is the target app/window still there?
3. `screenshot({})` or `describe_screen({})` — what's *actually* on screen right
   now? (You may be looking at a different app than you think.)
4. Read the `hint` in the last error response — it names the recovery step.
5. Check [troubleshooting.md](troubleshooting.md) for the error code.
