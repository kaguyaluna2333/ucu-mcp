import { UcuError, CaptureError, PermissionError, PlatformError, InputSynthesisError, ElementNotFoundError } from "../../util/errors.js";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAccessibilityPermissionError(error: unknown): boolean {
  return /not allowed|permission|assistive|accessibility/i.test(errorMessage(error));
}

export function rethrowCaptureError(error: unknown, operation: string): never {
  if (error instanceof UcuError) throw error;
  throw new CaptureError(`${operation} failed: ${errorMessage(error)}`);
}

export function rethrowAccessibilityError(error: unknown, operation: string): never {
  if (error instanceof UcuError) throw error;
  if (isAccessibilityPermissionError(error)) {
    throw new PermissionError("accessibility", "darwin");
  }
  throw new PlatformError(`${operation} failed: ${errorMessage(error)}`);
}

export function rethrowElementActionError(error: unknown, operation: string, elementId: string): never {
  if (error instanceof UcuError) throw error;
  if (isAccessibilityPermissionError(error)) {
    throw new PermissionError("accessibility", "darwin");
  }
  if (/element not found/i.test(errorMessage(error))) {
    throw new ElementNotFoundError(elementId);
  }
  throw new PlatformError(`${operation} failed: ${errorMessage(error)}`);
}

export function rethrowInputError(error: unknown, operation: string): never {
  if (error instanceof UcuError) throw error;
  throw new InputSynthesisError(`${operation} failed: ${errorMessage(error)}`);
}

export function normalizeAppName(name: string): string {
  // Drop all non-alphanumeric chars so app name variants match across
  // formattings: "CC Switch" / "cc-switch" / "cc_switch" / "CC.Switch"
  // all collapse to "ccswitch". This is what users (and LLMs) typically
  // produce from casual memory, and it's the only way focus_app can
  // resolve tray vs. windowed app identity reliably.
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function appNameMatches(processName: string, requestedApp: string): boolean {
  const process = normalizeAppName(processName);
  const requested = normalizeAppName(requestedApp);
  if (!process || !requested) return false;
  if (process === requested) return true;
  // Substring match only for requests >= 3 chars to avoid "code"→"vscode".
  // Only allow process.includes(requested) (not bidirectional) to prevent
  // short requests greedily absorbing longer unrelated process names.
  if (requested.length >= 3 && process.includes(requested)) return true;
  return false;
}

export function selectWindowForApp(windows: import("../base.js").WindowInfo[], requestedApp: string): import("../base.js").WindowInfo | undefined {
  const requested = normalizeAppName(requestedApp);
  const matched = windows.filter((window) => normalizeAppName(window.processName) === requested);
  const pool = matched.length > 0 ? matched : windows.filter((window) => appNameMatches(window.processName, requestedApp));
  if (pool.length === 0) return undefined;
  // Hard-filter to on-screen windows: an offscreen Chromium/Electron compositor
  // surface can be large enough that its area alone outscores a real on-screen
  // window (the +1000 onScreen bonus is noise vs ~60k area units). Only fall
  // back to offscreen/minimized candidates when no visible window exists.
  const onScreen = pool.filter((w) => w.isOnScreen && !w.isMinimized);
  const candidates = onScreen.length > 0 ? onScreen : pool;
  if (candidates.length === 1) return candidates[0];
  const scored = candidates.map((w) => ({
    w,
    score: (w.isOnScreen ? 1000 : 0) + (w.title ? 500 : 0) + (w.bounds.width * w.bounds.height),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].w;
}

export interface MacOSPlatformOptions {
  /**
   * Override native helper resolution.
   * - Map of folder name to absolute binary path to inject a specific helper.
   * - Set a value to null to skip that helper (force JXA fallback).
   * Used by tests to control native helper behavior without filesystem tricks.
   */
  nativeHelperPaths?: Record<string, string | null>;
}

export interface CachedElementDescriptor {
  elementId: string;
  appName: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  subrole?: string;
  identifier?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cachedAt: number;
}
