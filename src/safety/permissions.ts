import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PermissionType = "accessibility" | "screenRecording";

export interface PermissionCheckResult {
  granted: boolean;
  missing: PermissionType[];
}

export interface PermissionDetail {
  type: PermissionType;
  granted: boolean;
  instructions: string;
}

// Short-lived cache for individual permission checks. Permissions rarely change
// within a single tool sequence, but we keep TTL short so that a user granting
// permission mid-session is picked up quickly.
const PERMISSION_CACHE_TTL_MS = { granted: 5000, denied: 1000 };

interface PermissionCacheEntry {
  granted: boolean;
  cachedAt: number;
}

const permissionCache: Partial<Record<PermissionType, PermissionCacheEntry>> = {};

/** @internal Test hook to reset the permission cache. */
export function __resetPermissionCache(): void {
  permissionCache.accessibility = undefined;
  permissionCache.screenRecording = undefined;
}

function getCachedPermission(type: PermissionType): boolean | undefined {
  const entry = permissionCache[type];
  if (!entry) return undefined;
  const ttl = entry.granted ? PERMISSION_CACHE_TTL_MS.granted : PERMISSION_CACHE_TTL_MS.denied;
  if (Date.now() - entry.cachedAt > ttl) {
    permissionCache[type] = undefined;
    return undefined;
  }
  return entry.granted;
}

function setCachedPermission(type: PermissionType, granted: boolean): void {
  permissionCache[type] = { granted, cachedAt: Date.now() };
}

/**
 * Get the name of the terminal app that the user needs to authorize.
 */
export function getTerminalAppName(): string {
  // Walk up the process tree to find the terminal emulator
  const ppid = process.ppid;
  // Common terminal app names
  const env = process.env.TERM_PROGRAM || "";
  const nameMap: Record<string, string> = {
    "Apple_Terminal": "Terminal.app",
    "iTerm.app": "iTerm.app",
    "vscode": "Visual Studio Code",
    "alacritty": "Alacritty",
    "kitty": "kitty",
    "wezterm": "WezTerm",
    "ghostty": "Ghostty",
    "warp": "Warp",
    "hyper": "Hyper",
  };
  return nameMap[env] || env || "your terminal app";
}

/**
 * Open the macOS System Settings page for a permission.
 */
async function openPermissionSettings(type: PermissionType): Promise<void> {
  const url = type === "accessibility"
    ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  try {
    await execFileAsync("/usr/bin/open", [url], { timeout: 3000 });
  } catch {
    // Non-critical — best effort
  }
}

/**
 * Request accessibility permission by triggering the macOS system dialog.
 * Uses AXIsProcessTrustedWithOptions with kAXTrustedCheckOptionPrompt=true
 * which shows the system authorization prompt.
 */
async function requestAccessibilityWithPrompt(): Promise<boolean> {
  try {
    const script = `
      ObjC.import('CoreServices');
      var opts = $.NSDictionary.dictionaryWithObjectForObject(
        $(true), $("kAXTrustedCheckOptionPrompt")
      );
      $.AXIsProcessTrustedWithOptions(opts);
    `;
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-l", "JavaScript", "-e", script,
    ], { timeout: 10000 } as any);
    return (stdout as any).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Check accessibility by trying to use System Events via osascript.
 * macOS grants the PARENT process the TCC entry — we check via
 * a simple AXAPI call that returns the current process's status.
 *
 * NOTE: When running via `node`, the TCC entry is for "Terminal.app"
 * (or whichever terminal hosts node). The osascript subprocess
 * inherits the parent's TCC for accessibility because it runs
 * under the same application context via the shell.
 */
async function checkAccessibility(): Promise<boolean> {
  if (process.platform !== "darwin") return true;

  try {
    const script = `
      tell application "System Events"
        return (count of processes) as text
      end tell
    `;
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: 5000,
    } as any);
    const count = parseInt((stdout as any).trim(), 10);
    return !isNaN(count) && count > 0;
  } catch {
    return false;
  }
}

/**
 * Check screen recording by attempting a minimal screenshot.
 * screencapture respects TCC — it fails with a specific error
 * if the calling process doesn't have Screen Recording permission.
 */
async function checkScreenRecording(): Promise<boolean> {
  if (process.platform !== "darwin") return true;

  try {
    await execFileAsync("/usr/sbin/screencapture", [
      "-x", "-R", "0,0,1,1", "/dev/null",
    ], { timeout: 5000 });
    return true;
  } catch (e: any) {
    const msg = (e.stderr || e.message || "").toLowerCase();
    // screencapture returns error when no permission
    if (msg.includes("not authorized") || msg.includes("denied") || msg.includes("permission")) {
      return false;
    }
    // Other errors (file system) — permission is likely granted
    return true;
  }
}

export async function checkPermissions(): Promise<PermissionCheckResult> {
  if (process.platform !== "darwin") {
    return { granted: true, missing: [] };
  }
  const [hasAccessibility, hasScreenRecording] = await Promise.all([
    checkAccessibility(),
    checkScreenRecording(),
  ]);
  const missing: PermissionType[] = [];
  if (!hasAccessibility) missing.push("accessibility");
  if (!hasScreenRecording) missing.push("screenRecording");
  return { granted: missing.length === 0, missing };
}

export async function checkPermission(
  type: "accessibility" | "screenRecording"
): Promise<{ granted: boolean; message?: string }> {
  if (process.platform !== "darwin") {
    return { granted: true };
  }

  const appName = getTerminalAppName();

  if (type === "accessibility") {
    const cached = getCachedPermission("accessibility");
    const granted = cached ?? await checkAccessibility();
    if (cached === undefined) {
      setCachedPermission("accessibility", granted);
    }
    if (!granted) {
      // Trigger the macOS system prompt for Accessibility
      await requestAccessibilityWithPrompt();
      // Also open System Settings as a fallback
      await openPermissionSettings("accessibility");
      return {
        granted: false,
        message: `macOS Accessibility permission required for ${appName}. A system dialog should have appeared requesting authorization — please approve it. If no dialog appeared, open System Settings > Privacy & Security > Accessibility and manually enable ${appName}. Then restart ucu-mcp.`,
      };
    }
    return { granted: true };
  }

  const cached = getCachedPermission("screenRecording");
  const granted = cached ?? await checkScreenRecording();
  if (cached === undefined) {
    setCachedPermission("screenRecording", granted);
  }
  if (!granted) {
    // Open System Settings for Screen Recording
    await openPermissionSettings("screenRecording");
    return {
      granted: false,
      message: `macOS Screen Recording permission required for ${appName}. Opening System Settings now — please navigate to Privacy & Security > Screen Recording and enable ${appName}. Then restart ucu-mcp.`,
    };
  }
  return { granted: true };
}

export function getPermissionInstructions(type: PermissionType): string {
  const instructions: Record<PermissionType, string> = {
    accessibility: "Open System Settings > Privacy & Security > Accessibility. Add and enable your terminal application (e.g. Terminal.app, iTerm2, Alacritty). Restart ucu-mcp after granting.",
    screenRecording: "Open System Settings > Privacy & Security > Screen Recording. Add and enable your terminal application. Restart ucu-mcp after granting.",
  };
  return instructions[type];
}

export async function runPermissionDoctor(): Promise<PermissionDetail[]> {
  const details: PermissionDetail[] = [];
  const [accessibility, screenRecording] = await Promise.all([
    checkAccessibility(),
    checkScreenRecording(),
  ]);

  details.push({
    type: "accessibility",
    granted: accessibility,
    instructions: getPermissionInstructions("accessibility"),
  });
  details.push({
    type: "screenRecording",
    granted: screenRecording,
    instructions: getPermissionInstructions("screenRecording"),
  });

  return details;
}
