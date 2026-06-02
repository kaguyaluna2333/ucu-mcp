# UCU-MCP Safety Model

UCU-MCP operates in the user's graphical environment -- it sees screens, moves cursors, presses keys, and types text. That power demands a safety-first architecture that prevents accidental damage to the user's system and data.

## Safety Philosophy: Non-Invasive by Default

Every action UCU-MCP takes is filtered through a **SafetyGuard** before execution. The guard operates on a deny-by-default principle:

1. **Blocklist, not allowlist.** Known-dangerous actions are explicitly blocked. Everything else passes through, but the set of blocked actions is conservative and intentionally broad.
2. **Sensitive contexts are skipped entirely.** If the foreground window belongs to a password manager, banking portal, or cryptocurrency exchange, all actions are refused -- even innocuous ones like screenshots.
3. **Rate limiting prevents runaway automation.** A configurable minimum interval between consecutive actions ensures that bugs, loops, or adversarial prompts cannot flood the user's input queue.
4. **Permission checks happen before any operation.** The system verifies that the necessary OS-level permissions have been granted and surfaces clear instructions when they are missing.
5. **Locked screens stop automation.** On macOS, runtime checks block computer-use actions while the console is locked.
6. **Browser URLs are checked for sensitive destinations.** When a macOS browser target is known, action tools inspect its active URL and refuse password-manager, banking, payment, and crypto sites.
7. **Typed text is scanned for injection primitives.** Shell substitution, command chaining into interpreters, dangerous shell commands, and JXA/AppleScript primitives are rejected before input synthesis.

The result is an agent that can only act within a bounded, inspected surface -- never silently in the background on sensitive targets.

---

## SafetyGuard Rules

The `SafetyGuard` class in `src/safety/guard.ts` evaluates every proposed action through five sequential checks. If any check fails, the action is rejected with a human-readable reason.

### 1. Key Blocklist

When the action type is `"key"`, the joined shortcut string is normalized (lowercased, trimmed, modifiers sorted) and checked against a set of blocked shortcuts. A blocked shortcut returns immediately with:

```
{ allowed: false, reason: "Blocked shortcut: <keys>" }
```

Normalization ensures that `Cmd+Q`, `cmd+q`, and `Q+Cmd` are all treated identically.

### 2. Window Skip

For any action that carries a `windowTitle` parameter, the title is lowercased and tested against a list of sensitive-window patterns using substring matching. A match returns:

```
{ allowed: false, reason: 'Skipped sensitive window: "<title>"' }
```

This check runs for every action type -- clicks, key presses, typing, and screenshots are all refused when the foreground window is sensitive.

### 3. URL Blocklist

When the platform can provide browser context, action tools pass the current URL into `SafetyGuard`. The guard blocks known sensitive destinations including password managers, banking sites, payment processors, and cryptocurrency exchanges. This is best-effort on macOS browser apps such as Safari, Chrome, Arc, Edge, and Brave; if URL discovery fails, the guard does not fabricate a URL.

### 4. Typed Text Injection Scan

For `type_text`, `type`, `type_in_element`, and `set_value`, the guard scans typed text before any OS event is generated. It blocks suspicious payloads such as command substitution (`$()`), backtick substitution, command chaining (`&&`, `||`), pipes into interpreters, dangerous shell commands, and JXA/AppleScript primitives such as `ObjC.import`, `Application(`, and `do shell script`.

This is intentionally conservative because computer-use agents often type into terminals, browser address bars, and developer tools.

### 5. Rate Limiting

A timestamp is recorded after each allowed action. If the elapsed time since the last action is below the configured minimum (default 100 ms), the action is rejected:

```
{ allowed: false, reason: "Rate-limited: <elapsed>ms since last action (min <limit>ms)" }
```

The timer resets only on allowed actions, so a burst of rejected key-shortcut checks does not consume rate-limit budget.

---

## Default Blocked Keys

| Shortcut | Platform | Reason |
|---|---|---|
| `Cmd+Q` | macOS | Quit frontmost application |
| `Cmd+W` | macOS | Close frontmost window/tab |
| `Cmd+L` | macOS | Lock screen |
| `Cmd+Option+Esc` | macOS | Force-quit dialog |
| `Cmd+Ctrl+Power` | macOS | Force restart |
| `Cmd+Option+Power` | macOS | Sleep display |
| `Alt+F4` | Windows/Linux | Close window / quit application |
| `Alt+F2` | Linux | Run dialog |
| `Ctrl+Alt+Del` | Windows/Linux | System interrupt / task manager |
| `Ctrl+Alt+Backspace` | Linux | Kill X server |
| `Ctrl+Alt+T` | Linux | Open terminal |

---

## Default Skipped Window Patterns

Window titles are matched case-insensitively as substrings. The default list covers password managers, banking, and cryptocurrency applications:

| Pattern | Category |
|---|---|
| `1password` | Password manager |
| `bitwarden` | Password manager |
| `lastpass` | Password manager |
| `keepass` | Password manager |
| `dashlane` | Password manager |
| `keychain access` | Password manager (macOS) |
| `钥匙串访问` | Password manager (macOS, Chinese locale) |
| `bank` | Banking |
| `银行` | Banking (Chinese) |
| `paypal` | Payments |
| `stripe` | Payments |
| `robinhood` | Trading / crypto |
| `coinbase` | Cryptocurrency |

---

## How to Customize Rules

The `SafetyGuard` constructor accepts a `SafetyGuardConfig` object with three optional fields:

```typescript
interface SafetyGuardConfig {
  blockedKeys?: string[];      // Additional shortcuts to block
  skippedWindows?: string[];   // Additional window title patterns to skip
  blockedUrls?: string[];      // Additional URL substrings to block
  allowUnsafeText?: boolean;    // Disable injection scanning in controlled harnesses
  rateLimitMs?: number;        // Minimum ms between actions (default 100)
}
```

### Adding Blocked Keys

Extra shortcuts are normalized and merged with the built-in blocklist. They do not replace it.

```typescript
const guard = new SafetyGuard({
  blockedKeys: ["ctrl+shift+q", "cmd+shift+n"],
});
```

### Adding Skipped Windows

Extra patterns are lowercased and merged with the built-in list. Substring matching applies, so partial names work.

```typescript
const guard = new SafetyGuard({
  skippedWindows: ["Signal", "Telegram", "Slack - DM"],
});
```

### Adjusting Rate Limit

The default is 100 ms. Increase it for slower, more deliberate automation, or decrease it (with caution) for faster throughput.

```typescript
const guard = new SafetyGuard({
  rateLimitMs: 250, // at most ~4 actions per second
});
```

### Full Example

```typescript
import { SafetyGuard } from "./safety/guard";

const guard = new SafetyGuard({
  blockedKeys: ["ctrl+shift+q"],
  skippedWindows: ["Signal", "private-browsing"],
  rateLimitMs: 200,
});

// Check before every action
const result = guard.checkAction("key", { keys: ["cmd", "q"] });
if (!result.allowed) {
  console.warn(`Action denied: ${result.reason}`);
}
```

---

## Permission Requirements

UCU-MCP needs OS-level permissions to simulate input and capture the screen. The `permissions.ts` module provides a `checkPermissions()` function and a `runPermissionDoctor()` CLI helper to verify and report on these requirements.

### macOS

| Permission | Purpose | How to Grant |
|---|---|---|
| Accessibility | Input simulation (click, key, type) | System Settings > Privacy & Security > Accessibility |
| Screen Recording | Screenshots and screen capture | System Settings > Privacy & Security > Screen Recording |

The accessibility check runs a minimal AppleScript (`tell application "System Events" to keystroke ""`). The screen recording check attempts a silent `screencapture` to `/dev/null` -- on macOS 10.15+ this silently produces a zero-byte file when the permission is missing.

### Windows

| Permission | Purpose | How to Grant |
|---|---|---|
| UI Automation | Window enumeration and element interaction | Available by default on modern Windows |

The check loads the `UIAutomationClient` assembly via PowerShell and verifies that the `AutomationElement.RootElement` is accessible.

### Linux

| Permission | Purpose | How to Grant |
|---|---|---|
| X11 Display | X11-based screenshot and input | Set `DISPLAY` environment variable; ensure X server is running |
| Wayland Portal (optional) | Alternative to X11 for Wayland sessions | Install `xdg-desktop-portal` |

On Linux, X11 access (including XWayland) is required. Wayland portal support is informational; the system works if either X11 or Wayland portal is available.

### Programmatic Permission Check

```typescript
import { checkPermissions, runPermissionDoctor } from "./safety/permissions";

// Structured result
const result = await checkPermissions();
if (!result.granted) {
  console.error("Missing:", result.missing);
  console.error(result.details);
}

// Human-readable doctor report
console.log(await runPermissionDoctor());
```

### Checking a Single Permission

```typescript
import { checkPermission } from "./safety/permissions";

const canType = await checkPermission("accessibility");
const canSee = await checkPermission("screenRecording");
```

The `checkPermission` function accepts `"accessibility"`, `"screenRecording"`, `"uiAutomation"`, and `"x11"`. On platforms where a permission type is not applicable, it returns `true`.

---

## Safety Best Practices for MCP Consumers

### Always check before acting

Call `SafetyGuard.checkAction()` before dispatching every action. Never bypass the guard, even for actions that seem harmless -- the window-skip check may still apply.

### Respect rejection reasons

When `checkAction()` returns `{ allowed: false }`, the `reason` string is designed for end-user display. Surface it in logs, UI, or error responses so users understand why an action was blocked.

### Extend, do not replace, the defaults

The `blockedKeys` and `skippedWindows` config fields are additive. There is no mechanism to remove built-in entries. This is intentional: it prevents configuration errors from weakening the safety net.

### Set rate limits appropriate to your use case

100 ms (the default) allows up to 10 actions per second, which is sufficient for most UI automation workflows while preventing runaway loops. For headless or batch scenarios where speed matters less, increase the limit. For interactive demos where every action should be visible, raise it further.

### Run the permission doctor at startup

Call `runPermissionDoctor()` when your MCP server initializes. If permissions are missing, fail fast with clear instructions rather than producing cryptic errors at runtime.

### Do not store or log sensitive window content

If a window-skip check passes but the window title or screenshot may contain sensitive data (e.g., a partially visible banking tab), avoid persisting it. The window-skip list is a safety net, not a guarantee of non-sensitivity.

### Keep the guard instance per-session

`SafetyGuard` maintains internal state (the last-action timestamp for rate limiting). Create one instance per MCP session and reuse it. Creating a new instance resets the rate limiter and defeats its purpose.

### Handle permission changes gracefully

On macOS, users can revoke Accessibility or Screen Recording permissions at any time through System Settings. Periodically re-check permissions (e.g., on session resume or before critical operations) rather than assuming they persist indefinitely.

### Consider the blast radius of every action

Before sending an action through the guard, ask: "If this action were sent to the wrong window, what is the worst outcome?" If the answer is data loss, session termination, or irreversible system change, consider adding the relevant key or window pattern to your configuration.
