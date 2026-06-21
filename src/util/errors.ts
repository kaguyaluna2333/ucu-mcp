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
  static readonly defaultCode: string = "UCU_ERROR";
  readonly code: string;
  readonly retryable: boolean;
  /** Optional inline remediation hint surfaced by the platform layer. */
  readonly hint?: string;

  constructor(
    message: string,
    code?: string,
    retryable: boolean = false,
    hint?: string,
  ) {
    super(message);
    if (code === undefined) {
      // The default code applied to instances of this class when no explicit code is passed to the constructor.
      // See the static `defaultCode` declaration above for the per-class override mechanism.
      code = (this.constructor as typeof UcuError).defaultCode;
    }
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
    this.hint = hint;
  }

  /** Serialize for MCP response / JSON.stringify. */
  toJSON(): { name: string; code: string; retryable: boolean; message: string; hint?: string } {
    return {
      name: this.name,
      code: this.code,
      retryable: this.retryable,
      message: this.message,
      ...(this.hint && { hint: this.hint }),
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
  static override readonly defaultCode = "PLATFORM_ERROR";
  constructor(message: string, retryable: boolean = true) {
    super(message, PlatformError.defaultCode, retryable);
  }
}

// ---------------------------------------------------------------------------
// Safety Errors
// ---------------------------------------------------------------------------

/**
 * Action blocked by safety guard.
 */
export class SafetyError extends UcuError {
  static override readonly defaultCode = "SAFETY_BLOCKED";
  constructor(message: string) {
    super(message, SafetyError.defaultCode, false);
  }
}

// ---------------------------------------------------------------------------
// Permission Errors
// ---------------------------------------------------------------------------

/**
 * Missing OS accessibility/screen-recording permissions.
 */
export class PermissionError extends UcuError {
  static override readonly defaultCode = "PERMISSION_DENIED";
  constructor(permission: string, platform: string) {
    super(getPermissionMessage(permission, platform), PermissionError.defaultCode, false);
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
  static override readonly defaultCode = "WINDOW_NOT_FOUND";
  constructor(windowId: string, options?: { hint?: string }) {
    super(
      `Window ${windowId} not found. It may have been closed. Run list_windows to get fresh IDs.`,
      WindowNotFoundError.defaultCode,
      false,
      options?.hint,
    );
  }
}

/**
 * Active target window is no longer available.
 */
export class TargetStaleError extends UcuError {
  static override readonly defaultCode = "TARGET_STALE";
  constructor(windowId: string) {
    super(
      `Active target window ${windowId} is no longer available. Run focus_app or list_windows to refresh.`,
      TargetStaleError.defaultCode,
      false,
    );
  }
}

/**
 * Requested accessibility element ID no longer resolves.
 */
export class ElementNotFoundError extends UcuError {
  static override readonly defaultCode = "ELEMENT_NOT_FOUND";
  constructor(elementId: string) {
    super(
      `Element ${elementId} not found. It may have been removed or invalidated. Run find_element to get a fresh ID.`,
      ElementNotFoundError.defaultCode,
      false,
    );
  }
}

// ---------------------------------------------------------------------------
// Input Errors
// ---------------------------------------------------------------------------

/**
 * Keystroke or mouse event injection failed.
 */
export class InputSynthesisError extends UcuError {
  static override readonly defaultCode = "INPUT_FAILED";
  constructor(message: string) {
    super(message, InputSynthesisError.defaultCode, true);
  }
}

/**
 * The request is well-formed JSON, but asks for a parameter combination this
 * implementation does not support.
 */
export class UnsupportedParameterError extends UcuError {
  static override readonly defaultCode = "UNSUPPORTED_PARAMETER";
  constructor(message: string) {
    super(message, UnsupportedParameterError.defaultCode, false);
  }
}

// ---------------------------------------------------------------------------
// Capture Errors
// ---------------------------------------------------------------------------

/**
 * Screenshot or window-state capture failed.
 */
export class CaptureError extends UcuError {
  static override readonly defaultCode = "CAPTURE_FAILED";
  constructor(message: string) {
    super(message, CaptureError.defaultCode, true);
  }
}
