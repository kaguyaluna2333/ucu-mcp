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
}

export interface FindElementResult {
  id: string;
  role: string;
  name: string;
  value?: string;
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

  // Mouse Actions
  click(x: number, y: number, button?: "left" | "right" | "middle", doubleClick?: boolean): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(startX: number, startY: number, endX: number, endY: number, button?: "left" | "right" | "middle", duration?: number): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;

  // Cursor State
  getCursorPosition(): CursorPosition;

  // OCR
  ocr(display?: number, region?: ScreenRegion): Promise<OcrResult>;

  // Keyboard Actions
  type(text: string, delay?: number): Promise<void>;
  key(keys: string[]): Promise<void>;

  // Accessibility (AX) Element Actions
  findElement(options: FindElementOptions): Promise<FindElementResponse>;
  clickElement(elementId: string, app?: string): Promise<void>;
  typeInElement(elementId: string, text: string, app?: string, clearFirst?: boolean): Promise<void>;
  setElementValue?(elementId: string, value: string, app?: string): Promise<void>;

  // Safety State
  isScreenLocked?(): boolean;

  // Focus Management
  saveFocus?(): Promise<void>;
  restoreFocus?(): Promise<void>;

  // Clipboard
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
}
