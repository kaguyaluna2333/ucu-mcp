/**
 * Error taxonomy for UCU-MCP.
 *
 * All errors inherit from UcuError and are categorized by:
 *   - code: machine-readable error code (also exposed via toJSON)
 *   - retryable: whether the operation can be retried
 */

// ---------------------------------------------------------------------------
// Base Error Class
// ---------------------------------------------------------------------------

export class UcuError extends Error {
  /** Default error code for this class. Subclasses override. */
  static readonly code: string = "UCU_ERROR";
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    code?: string,
    retryable: boolean = false,
  ) {
    super(message);
    if (code === undefined) {
      code = (this.constructor as typeof UcuError).code;
    }
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
  }

  /** Serialize for MCP response / JSON.stringify. */
  toJSON(): { name: string; code: string; retryable: boolean; message: string } {
    return {
      name: this.name,
      code: this.code,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Platform Errors
// ---------------------------------------------------------------------------

/**
 * Native API call failed (permissions, OS error, timeout).
 */
export class PlatformError extends UcuError {
  static override readonly code = "PLATFORM_ERROR";
  constructor(message: string, retryable: boolean = true) {
    super(message, PlatformError.code, retryable);
  }
}

// ---------------------------------------------------------------------------
// Safety Errors
// ---------------------------------------------------------------------------

/**
 * Action blocked by safety guard.
 */
export class SafetyError extends UcuError {
  static override readonly code = "SAFETY_BLOCKED";
  constructor(message: string) {
    super(message, SafetyError.code, false);
  }
}

// ---------------------------------------------------------------------------
// Permission Errors
// ---------------------------------------------------------------------------

/**
 * Missing OS accessibility/screen-recording permissions.
 */
export class PermissionError extends UcuError {
  static override readonly code = "PERMISSION_DENIED";
  constructor(permission: string, platform: string) {
    super(getPermissionMessage(permission, platform), PermissionError.code, false);
  }
}

function getPermissionMessage(permission: string, platform: string): string {
  if (platform === "darwin") {
    return `Missing ${permission} permission. Grant it in System Settings > Privacy & Security > ${permission}.`;
  }
  return `Missing ${permission} permission for this operation.`;
}

// ---------------------------------------------------------------------------
// Window Errors
// ---------------------------------------------------------------------------

/**
 * Requested window ID no longer exists.
 */
export class WindowNotFoundError extends UcuError {
  static override readonly code = "WINDOW_NOT_FOUND";
  constructor(windowId: string) {
    super(
      `Window ${windowId} not found. It may have been closed. Run list_windows to get fresh IDs.`,
      WindowNotFoundError.code,
      false,
    );
  }
}

/**
 * Active target window is no longer available.
 */
export class TargetStaleError extends UcuError {
  static override readonly code = "TARGET_STALE";
  constructor(windowId: string) {
    super(
      `Active target window ${windowId} is no longer available. Run focus_app or list_windows to refresh.`,
      TargetStaleError.code,
      false,
    );
  }
}

/**
 * Requested accessibility element ID no longer resolves.
 */
export class ElementNotFoundError extends UcuError {
  static override readonly code = "ELEMENT_NOT_FOUND";
  constructor(elementId: string) {
    super(
      `Element ${elementId} not found. It may have been removed or invalidated. Run find_element to get a fresh ID.`,
      ElementNotFoundError.code,
      false,
    );
  }
}

// ---------------------------------------------------------------------------
// Input Errors
// ---------------------------------------------------------------------------

/**
 * Click/scroll target is outside screen bounds.
 */
export class CoordinateError extends UcuError {
  static override readonly code = "COORDINATE_OUT_OF_BOUNDS";
  constructor(x: number, y: number, bounds: { width: number; height: number }) {
    super(
      `Coordinate (${x}, ${y}) is outside screen bounds (0-${bounds.width}, 0-${bounds.height}).`,
      CoordinateError.code,
      false,
    );
  }
}

/**
 * Keystroke or mouse event injection failed.
 */
export class InputSynthesisError extends UcuError {
  static override readonly code = "INPUT_FAILED";
  constructor(message: string) {
    super(message, InputSynthesisError.code, true);
  }
}

/**
 * The request is well-formed JSON, but asks for a parameter combination this
 * implementation does not support.
 */
export class UnsupportedParameterError extends UcuError {
  static override readonly code = "UNSUPPORTED_PARAMETER";
  constructor(message: string) {
    super(message, UnsupportedParameterError.code, false);
  }
}

// ---------------------------------------------------------------------------
// Capture Errors
// ---------------------------------------------------------------------------

/**
 * Screenshot or window-state capture failed.
 */
export class CaptureError extends UcuError {
  static override readonly code = "CAPTURE_FAILED";
  constructor(message: string) {
    super(message, CaptureError.code, true);
  }
}
