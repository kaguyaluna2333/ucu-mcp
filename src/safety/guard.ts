/**
 * SafetyGuard - Action safety checker for UCU automation.
 *
 * Evaluates proposed actions against a set of configurable rules:
 *   - key-blocklist: blocks dangerous keyboard shortcuts
 *   - window-skip:   skips sensitive windows (banking, password managers)
 *   - rate-limit:    throttles action frequency
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface SafetyGuardConfig {
  /** Extra shortcut patterns to block (in addition to built-ins). */
  blockedKeys?: string[];
  /** Extra window title patterns to skip (in addition to built-ins). */
  skippedWindows?: string[];
  /** Extra URL patterns to block (in addition to built-ins). */
  blockedUrls?: string[];
  /** Disable text injection scanning for controlled test harnesses. */
  allowUnsafeText?: boolean;
  /** Minimum milliseconds between consecutive actions (default 100). */
  rateLimitMs?: number;
}

// ---------------------------------------------------------------------------
// Built-in blocked shortcuts
// ---------------------------------------------------------------------------

const DEFAULT_BLOCKED_KEYS: string[] = [
  // macOS – app-level
  "cmd+q",
  "cmd+shift+q",    // log out（方向2 后字母 q 可解析，须显式拦截）
  "cmd+option+q",   // log out variant
  "cmd+w",
  "cmd+l",          // lock screen
  // macOS – system-level
  "cmd+option+esc", // Force-quit dialog
  "cmd+ctrl+power", // force restart
  "cmd+option+power", // sleep
  // Windows / Linux
  "alt+f4",
  "alt+f2",         // Linux run dialog
  "ctrl+alt+del",
  "ctrl+alt+backspace", // Linux kill X
  "ctrl+alt+t",     // Linux terminal
];

// ---------------------------------------------------------------------------
// Built-in sensitive window patterns (case-insensitive substring match)
// ---------------------------------------------------------------------------

const DEFAULT_SKIPPED_WINDOWS: string[] = [
  "1password",
  "bitwarden",
  "lastpass",
  "keepass",
  "dashlane",
  "keychain access",
  "钥匙串访问",
  "bank",
  "银行",
  "paypal",
  "stripe",
  "robinhood",
  "coinbase",
];

const DEFAULT_BLOCKED_URL_PATTERNS: string[] = [
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
  "dashlane.com",
  "keepersecurity.com",
  "icloud.com/keychain",
  "paypal.com",
  "stripe.com",
  "bank",
  "bankofamerica.com",
  "chase.com",
  "wellsfargo.com",
  "capitalone.com",
  "americanexpress.com",
  "coinbase.com",
  "robinhood.com",
  "binance.com",
  "kraken.com",
];

const DEFAULT_TEXT_INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\s*\(/, reason: "shell command substitution" },
  { pattern: /`[^`]+`/, reason: "shell backtick substitution" },
  { pattern: /&&|\|\|/, reason: "shell command chaining" },
  { pattern: /\|\s*(sh|bash|zsh|python|ruby|perl|node)\b/i, reason: "piping into an interpreter" },
  { pattern: /\b(sudo\s+rm|rm\s+-rf|mkfs|diskutil\s+erase|dd\s+if=|chmod\s+-R\s+777)\b/i, reason: "dangerous shell command" },
  { pattern: /\b(ObjC\.import|Application\s*\(|do\s+shell\s+script)\b/, reason: "AppleScript/JXA injection primitive" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Modifier alias → canonical name. MAC_MODIFIER_FLAGS accepts both forms
 *  (cmd/command, option/alt, control/ctrl); normalize them so a blocklist
 *  entry like "cmd+option+esc" also catches "cmd+alt+esc". */
const MODIFIER_CANONICAL: Record<string, string> = {
  alt: "option", ctrl: "control", cmd: "command",
};

/** Normalize a shortcut string to lowercase, trimmed, sorted modifiers with
 *  modifier aliases canonicalized (alt→option, ctrl→control, cmd→command). */
function normalizeShortcut(raw: string): string {
  return raw
    .toLowerCase()
    .split("+")
    .map((s) => {
      const t = s.trim();
      return MODIFIER_CANONICAL[t] ?? t;
    })
    .sort()
    .join("+");
}

// ---------------------------------------------------------------------------
// Action classification (observe vs input)
// ---------------------------------------------------------------------------

/** Actions that observe UI/system state without altering it. */
export const OBSERVE_ACTIONS: ReadonlySet<string> = new Set([
  "screenshot",
  "list_windows",
  "list_apps",
  "get_window_state",
  "get_screen_size",
  "get_cursor_position",
  "ocr",
  "find_element",
  "wait",
  "wait_for_element",
  "doctor",
  "clipboard_read",
  // focus_app only sets the active target context via AppleScript activate
  // and an AX window lookup — it does not synthesize mouse or keyboard input,
  // so the user-activity pause must not block it. (OpenCode 0.3.7 follow-up)
  "focus_app",
  // describe_screen reads screen state (OCR + AX), no input synthesis.
  "describe_screen",
]);

/** Actions that synthesize user input — need full user-activity protection. */
export const INPUT_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "scroll",
  "drag",
  "move",
  "type_text",
  "press_key",
  "click_element",
  "type_in_element",
  "set_value",
  "click_menu_bar_extra",
  "clipboard_write",
]);

export function classifyAction(action: string): "observe" | "input" | "other" {
  if (OBSERVE_ACTIONS.has(action)) return "observe";
  if (INPUT_ACTIONS.has(action)) return "input";
  return "other";
}

// ---------------------------------------------------------------------------
// SafetyGuard
// ---------------------------------------------------------------------------

export class SafetyGuard {
  private readonly blockedKeys: Set<string>;
  private readonly skippedWindows: string[];
  private readonly blockedUrls: string[];
  private readonly allowUnsafeText: boolean;
  private readonly rateLimitMs: number;
  private lastActionTime = 0;
  private lastUserActivityTime = 0;
  private userActivityPauseMs = 2000;

  constructor(config?: SafetyGuardConfig) {
    const extra = (config?.blockedKeys ?? []).map(normalizeShortcut);
    this.blockedKeys = new Set([
      ...DEFAULT_BLOCKED_KEYS.map(normalizeShortcut),
      ...extra,
    ]);

    this.skippedWindows = [
      ...DEFAULT_SKIPPED_WINDOWS,
      ...(config?.skippedWindows ?? []),
    ].map((p) => p.toLowerCase());

    this.blockedUrls = [
      ...DEFAULT_BLOCKED_URL_PATTERNS,
      ...(config?.blockedUrls ?? []),
    ].map((p) => p.toLowerCase());

    this.allowUnsafeText = config?.allowUnsafeText ?? false;
    this.rateLimitMs = config?.rateLimitMs ?? 100;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Evaluate whether the proposed action should be allowed.
   *
   * @param action  The action type (e.g. "key", "click", "type", "screenshot").
   * @param params  Arbitrary action parameters; expected keys depend on action.
   *                - "key":         { keys: string[] }
   *                - any action:    { windowTitle?: string }
   */
  checkAction(
    action: string,
    params: Record<string, unknown> = {},
    options: { skipUserActivityPause?: boolean } = {},
  ): SafetyCheckResult {
    // 1. Key blocklist -------------------------------------------------------
    if (action === "key" || action === "press_key") {
      const keys = params.keys as string[] | undefined;
      if (keys && keys.length > 0) {
        const normalized = normalizeShortcut(keys.join("+"));
        if (this.blockedKeys.has(normalized)) {
          return {
            allowed: false,
            reason: `Blocked shortcut: ${keys.join("+")}`,
          };
        }
      }
    }

    // 2. Window skip ----------------------------------------------------------
    const windowTitle =
      typeof params.windowTitle === "string" ? params.windowTitle : undefined;
    if (windowTitle) {
      const lower = windowTitle.toLowerCase();
      for (const pattern of this.skippedWindows) {
        if (lower.includes(pattern)) {
          return {
            allowed: false,
            reason: `Skipped sensitive window: "${windowTitle}"`,
          };
        }
      }
    }

    // 3. URL blocklist --------------------------------------------------------
    const url = typeof params.url === "string" ? params.url : undefined;
    if (url) {
      const lower = url.toLowerCase();
      for (const pattern of this.blockedUrls) {
        if (lower.includes(pattern)) {
          return {
            allowed: false,
            reason: `Blocked sensitive URL: ${url}`,
          };
        }
      }
    }

    // 4. Text injection scan --------------------------------------------------
    if (!this.allowUnsafeText && (action === "type" || action === "type_text" || action === "type_in_element" || action === "set_value" || action === "clipboard_write")) {
      const text = typeof params.text === "string"
        ? params.text
        : typeof params.value === "string"
          ? params.value
          : undefined;
      if (text) {
        for (const { pattern, reason } of DEFAULT_TEXT_INJECTION_PATTERNS) {
          if (pattern.test(text)) {
            return {
              allowed: false,
              reason: `Blocked suspicious typed text (${reason})`,
            };
          }
        }
      }
    }

    // 5. Rate limit -----------------------------------------------------------
    const now = Date.now();
    const elapsed = now - this.lastActionTime;
    if (elapsed < this.rateLimitMs) {
      return {
        allowed: false,
        reason: `Rate-limited: ${elapsed}ms since last action (min ${this.rateLimitMs}ms)`,
      };
    }

    // 6. User activity pause (skipped for observe-class actions) -----------------
    if (!options.skipUserActivityPause && this.isUserActivityPauseActive()) {
      return {
        allowed: false,
        reason: `User activity detected — pausing automation for ${this.userActivityPauseMs}ms`,
      };
    }

    this.lastActionTime = now;
    return { allowed: true };
  }

  // -----------------------------------------------------------------------
  // User Activity Monitoring
  // -----------------------------------------------------------------------

  /** Record that the user performed an activity (mouse/keyboard). */
  recordUserActivity(): void {
    this.lastUserActivityTime = Date.now();
  }

  /** Set the pause duration after user activity (default 2000ms). */
  setUserActivityPauseMs(ms: number): void {
    this.userActivityPauseMs = ms;
  }

  /** Check if user activity pause is still active. */
  isUserActivityPauseActive(): boolean {
    if (this.userActivityPauseMs <= 0) return false;
    return Date.now() - this.lastUserActivityTime < this.userActivityPauseMs;
  }
}
