# Workflows

Common task playbooks. Each shows the preferred tool sequence and the fallback
path when the primary path is blocked.

---

## 1. Fill a form field

**Primary (AX):**
```
focus_app("Safari")
find_element({ text: "Email", role: "AXTextField" })
  → elementId "Safari/w0/42"
type_in_element({ elementId: "Safari/w0/42", text: "user@example.com" })
```

**Fallback (AX value set, for non-text controls):**
```
set_value({ elementId: "...", value: "option" })
```

**Fallback (coordinates, when AX is opaque):**
```
screenshot({})
ocr({})  → blocks[].text === "Email" → {x, y, width, height}
click({ x: block.x + block.width/2, y: block.y + block.height/2 })
type_text({ text: "user@example.com" })
```

---

## 2. Operate a menu-bar / tray app (e.g. cc-switch)

Tray apps' status items live in `SystemUIServer`, not the app's own window AX
tree. `focus_app` alone may return `WINDOW_NOT_FOUND`.

```
focus_app("cc-switch")           # establishes tray target if status item found
click_menu_bar_extra({ app: "cc-switch", name: "switch" })  # opens the menu
# menu is now open — find items inside it:
find_element({ text: "使用统计", app: "cc-switch" })
  → elementId
click_element({ elementId })
```

If the menu's AX tree is opaque (some Tauri/Electron menus):
```
click_menu_bar_extra({ app: "cc-switch" })
screenshot({})
ocr({})  → locate "使用统计" by text → coordinates
click({ x, y })
```

---

## 3. Electron / WebView opaque UI

Electron/Tauri apps often expose only a near-empty `AXGroup`. The runtime `hint`
on `find_element` and `list_windows` tells you when this is happening.

```
find_element({ text: "Submit" })
  → 0 results, hint: "app is likely Electron... screenshot → ocr → click(x,y)"

screenshot({})
ocr({ region: { x, y, width, height } })  # or full screen
  → blocks[].text === "Submit" → {x, y, width, height}
click({ x: block.x + block.width/2, y: block.y + block.height/2 })
```

For repeated interaction with a known-opaque app, snapshot once with
`describe_screen` to plan, then drive by coordinates.

---

## 4. Vision-degraded environment (image content not visible)

When the model cannot see `screenshot` image blocks (relay/downgrade to URLs),
switch to text-based screen reading:

```
describe_screen({ ocr: true, includeAx: true })
  → { screen, foregroundWindow, ocr:{blocks}, ax:{elements}, errors }

# or, if you also want the image for clients that DO support it:
screenshot({ describe: true })
  → [image block, text description block]
```

`describe_screen` never throws — OCR and AX each try/catch independently, so a
Vision failure still returns AX state and vice versa. Check `errors[]` to know
what was skipped/failed.

---

## 5. Recover from TARGET_STALE

The active window target can go stale (window closed, app restarted, pid
changed). AX tools throw `TARGET_STALE`.

```
# error response includes hint: "Run focus_app again for the target app..."
focus_app("Safari")              # re-establishes target
find_element({ text: "Save" })   # retry — cache refetches equivalent nodes
click_element({ elementId })
```

`type_in_element` automatically refetches an equivalent AX node if the original
`elementId` is stale, so a single retry often succeeds without `focus_app`.

---

## 6. Verify an action succeeded

Always verify after clicks/types — UI may not have updated, or the wrong element
was hit.

```
click_element({ elementId, captureAfter: true })   # screenshot in response
# or explicitly:
screenshot({})
# or check AX state:
get_window_state({})  → focusedElement / tree reflects the change
# or wait for a specific change:
wait_for_element({ text: "Saved", until: "appear", timeout: 3000 })
```

---

## 7. Multi-step task with error recovery

```
doctor()                                  # verify permissions first
list_apps()
focus_app("Notes")
find_element({ text: "New Note" }) → id
click_element({ elementId: id, captureAfter: true })

# if click_element throws ELEMENT_NOT_FOUND:
find_element({ text: "New Note" }) → id2  # refetch, id may have changed
click_element({ elementId: id2 })

type_in_element({ elementId: bodyId, text: "Hello" })
screenshot({})                            # confirm content
```
