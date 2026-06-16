export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenSize {
  width: number;
  height: number;
  scaleFactor?: number;
  estimated?: boolean;
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg";
  maxWidth?: number;
}

export interface CursorPosition {
  x: number;
  y: number;
}

export interface WindowInfo {
  id: string;
  title: string;
  processName: string;
  pid: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isMinimized: boolean;
  isOnScreen: boolean;
  /** Real CGWindowID (kCGWindowNumber) — needed for per-process event posting (focus-without-raise). Undefined for JXA-fallback enumeration. */
  windowNumber?: number;
}

export interface AppInfo {
  name: string;
  pid: number;
  isFrontmost: boolean;
  windowCount: number;
}

export interface AppTarget {
  targetId: string;
  appName: string;
  pid: number;
  windowId?: string;
  title?: string;
  capturedAt: string;
  /** Real CGWindowID for per-process event posting (focus-without-raise). Absent for tray targets. */
  windowNumber?: number;
}

export interface BrowserContext {
  appName: string;
  url?: string;
  title?: string;
}

export interface ElementInfo {
  role: string;
  name: string;
  description?: string;
  value?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  children?: ElementInfo[];
  states: string[];
}

export interface OcrElement {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface OcrResult {
  elements: OcrElement[];
  fullText: string;
}

export interface FindElementOptions {
  text?: string;
  role?: string;
  app?: string;
  depth?: number;
  includeBounds?: boolean;
  maxResults?: number;
  textMode?: "contains" | "exact" | "regex";
  visibleOnly?: boolean;
  /** Match against the AX element's current value attribute (respects textMode). */
  value?: string;
  /** Return only the Nth match (0-based) after all other filtering and sorting. */
  index?: number;
  /** Sort results by ascending distance to this point and return closest first. */
  near?: { x: number; y: number };
}

export interface FindElementResult {
  id: string;
  role: string;
  name: string;
  value?: string;
  subrole?: string;
  identifier?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  description?: string;
}

export interface FindElementMetrics {
  scannedCount: number;
  matchedCount: number;
  durationMs: number;
  truncated: boolean;
}

export interface FindElementResponse {
  results: FindElementResult[];
  metrics: FindElementMetrics;
}

export interface WindowState {
  window: WindowInfo;
  focusedElement?: ElementInfo;
  tree?: ElementInfo;
}

/**
 * Outcome of an AX-driven click — surfaces whether AXPress was used and whether
 * its effect was observable. `verified:false` means either the element exposed
 * no observable state (inconclusive) or the click fell back to coordinates
 * (silent AXPress swallow on Tauri/Electron). The tool layer surfaces this so
 * the model can decide whether to re-observe via screenshot/get_window_state.
 */
export interface ClickResult {
  method: "axpress" | "coordinate";
  verified: boolean;
}

/**
 * Structured text description of the screen — a fallback for environments where
 * image content blocks are downgraded to URLs (so the model cannot see screenshots).
 * Each source (OCR / AX / foreground) is collected independently; failures are
 * aggregated in `errors` rather than thrown.
 */
export interface ScreenDescription {
  capturedAt: string;
  screen: ScreenSize;
  foregroundWindow?: WindowInfo;
  ocr: { blocks: OcrElement[]; fullText: string; status: "ok" | "skipped" | "failed" };
  ax: { elements?: ElementInfo; status: "ok" | "skipped" | "failed"; windowId?: string };
  errors: Array<{ source: "ocr" | "ax" | "foreground" | "screen"; message: string }>;
}

/**
 * How an input event was dispatched. "per-pid" = posted to the target process
 * via SLEventPostToPid/CGEventPostToPid (no global cursor move, no foreground
 * theft — Codex-style background operation). "hid-tap" = posted to the global
 * HID event tap (moves the cursor; fallback when no pid or skylight unavailable).
 */
export type DispatchMethod = "per-pid" | "hid-tap";

export interface Platform {
  // Screenshot
  screenshot(display?: number, region?: ScreenRegion, options?: ScreenshotOptions): Promise<Buffer>;
  screenshotWindow?(windowId: string, options?: ScreenshotOptions): Promise<Buffer>;

  // Screen Info
  getScreenSize(display?: number): ScreenSize;

  // Window Management
  listApps?(): Promise<AppInfo[]>;
  focusApp?(app: string): Promise<AppTarget>;
  getActiveBrowserContext?(app?: string): Promise<BrowserContext | undefined>;
  listWindows(includeMinimized?: boolean): Promise<WindowInfo[]>;
  getWindowState(windowId?: string, depth?: number, includeBounds?: boolean): Promise<WindowState>;

  // Mouse Actions — return the dispatch method used (per-pid vs hid-tap).
  click(x: number, y: number, button?: "left" | "right" | "middle", doubleClick?: boolean): Promise<DispatchMethod | void>;
  move(x: number, y: number): Promise<DispatchMethod | void>;
  drag(startX: number, startY: number, endX: number, endY: number, button?: "left" | "right" | "middle", duration?: number): Promise<DispatchMethod | void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<DispatchMethod | void>;

  // Cursor State
  getCursorPosition(): CursorPosition;

  // OCR
  ocr(display?: number, region?: ScreenRegion): Promise<OcrResult>;

  // Keyboard Actions — return the dispatch method used.
  type(text: string, delay?: number): Promise<DispatchMethod | void>;
  key(keys: string[]): Promise<DispatchMethod | void>;

  // Accessibility (AX) Element Actions
  findElement(options: FindElementOptions): Promise<FindElementResponse>;
  clickElement(elementId: string, app?: string): Promise<ClickResult>;
  typeInElement(elementId: string, text: string, app?: string, clearFirst?: boolean): Promise<void>;
  setElementValue?(elementId: string, value: string, app?: string): Promise<void>;
  // 菜单栏 status item（托盘应用，LSUIElement）。macOS 专有，Windows/Linux 可不实现。
  findMenuBarExtra?(app: string): Promise<unknown[]>;
  clickMenuBarExtra?(app: string, selector?: { description?: string; name?: string; index?: number }): Promise<ClickResult>;

  // Safety State
  isScreenLocked?(): boolean;

  // Focus Management — @deprecated: intentionally disabled (CGEvent works at HID layer,
  // no frontmost requirement). Retained for API compat; not called from the action pipeline.
  saveFocus?(): Promise<void>;
  restoreFocus?(): Promise<void>;

  // Clipboard
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
}
