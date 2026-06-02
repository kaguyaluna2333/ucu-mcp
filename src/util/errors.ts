/**
 * Error taxonomy for UCU-MCP.
 *
 * All errors inherit from UcuError and are categorized by:
 *   - code: machine-readable error code
 *   - retryable: whether the operation can be retried
 */

// ---------------------------------------------------------------------------
// Base Error Class
// ---------------------------------------------------------------------------

export class UcuError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: string = "UCU_ERROR",
    retryable: boolean = false,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Platform Errors
// ---------------------------------------------------------------------------

/**
 * Native API call failed (permissions, OS error, timeout).
 */
export class PlatformError extends UcuError {
  constructor(message: string, retryable: boolean = true) {
    super(message, "PLATFORM_ERROR", retryable);
  }
}

// ---------------------------------------------------------------------------
// Safety Errors
// ---------------------------------------------------------------------------

/**
 * Action blocked by safety guard.
 */
export class SafetyError extends UcuError {
  constructor(message: string) {
    super(message, "SAFETY_BLOCKED", false);
  }
}

// ---------------------------------------------------------------------------
// Permission Errors
// ---------------------------------------------------------------------------

/**
 * Missing OS accessibility/screen-recording permissions.
 */
export class PermissionError extends UcuError {
  constructor(permission: string, platform: string) {
    super(getPermissionMessage(permission, platform), "PERMISSION_DENIED", false);
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
  constructor(windowId: string) {
    super(
      `Window ${windowId} not found. It may have been closed. Run list_windows to get fresh IDs.`,
      "WINDOW_NOT_FOUND",
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
  constructor(x: number, y: number, bounds: { width: number; height: number }) {
    super(
      `Coordinate (${x}, ${y}) is outside screen bounds (0-${bounds.width}, 0-${bounds.height}).`,
      "COORDINATE_OUT_OF_BOUNDS",
      false,
    );
  }
}

/**
 * Keystroke or mouse event injection failed.
 */
export class InputSynthesisError extends UcuError {
  constructor(message: string) {
    super(message, "INPUT_FAILED", true);
  }
}

/**
 * The request is well-formed JSON, but asks for a parameter combination this
 * implementation does not support.
 */
export class UnsupportedParameterError extends UcuError {
  constructor(message: string) {
    super(message, "UNSUPPORTED_PARAMETER", false);
  }
}

// ---------------------------------------------------------------------------
// Capture Errors
// ---------------------------------------------------------------------------

/**
 * Screenshot or window-state capture failed.
 */
export class CaptureError extends UcuError {
  constructor(message: string) {
    super(message, "CAPTURE_FAILED", true);
  }
}
