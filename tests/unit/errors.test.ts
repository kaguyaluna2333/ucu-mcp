import { describe, it, expect } from "vitest";
import {
  UcuError,
  PlatformError,
  SafetyError,
  PermissionError,
  WindowNotFoundError,
  ElementNotFoundError,
  InputSynthesisError,
  UnsupportedParameterError,
  CaptureError,
} from "../../src/util/errors.js";

describe("UcuError (base)", () => {
  it("uses default code and non-retryable flag", () => {
    const err = new UcuError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UcuError);
    expect(err.message).toBe("boom");
    expect(err.code).toBe("UCU_ERROR");
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("UcuError");
  });

  it("accepts custom code and retryable flag", () => {
    const err = new UcuError("x", "CUSTOM", true);
    expect(err.code).toBe("CUSTOM");
    expect(err.retryable).toBe(true);
  });
});

describe("PlatformError", () => {
  it("inherits from UcuError and is retryable by default", () => {
    const err = new PlatformError("screencapture failed");
    expect(err).toBeInstanceOf(UcuError);
    expect(err.code).toBe("PLATFORM_ERROR");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("PlatformError");
  });

  it("can be marked non-retryable", () => {
    const err = new PlatformError("hard fail", false);
    expect(err.retryable).toBe(false);
  });
});

describe("SafetyError", () => {
  it("uses SAFETY_BLOCKED code and is non-retryable", () => {
    const err = new SafetyError("blocked by guard");
    expect(err).toBeInstanceOf(UcuError);
    expect(err.code).toBe("SAFETY_BLOCKED");
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("SafetyError");
  });
});

describe("PermissionError", () => {
  it("emits darwin-specific message and PERMISSION_DENIED code", () => {
    const err = new PermissionError("Accessibility", "darwin");
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Accessibility");
    expect(err.message).toContain("System Settings");
  });

  it("emits generic message on non-darwin platforms", () => {
    const err = new PermissionError("screenRecording", "linux");
    expect(err.message).toContain("screenRecording");
    expect(err.message).not.toContain("System Settings");
  });
});

describe("WindowNotFoundError with hint", () => {
  it("preserves an inline hint set by the platform layer (Electron AX case)", () => {
    // The platform layer attaches a `hint` field on the error to surface
    // remediation guidance (e.g. "Electron AX tree not exposed"). The error
    // class is plain Error/WindowNotFoundError, so we just verify the
    // property round-trips and is a non-empty string when set.
    const err = new WindowNotFoundError("CC Switch");
    (err as Error & { hint?: string }).hint =
      "list_windows returned no match. If the app is Electron, grant Accessibility to the Electron process.";
    expect((err as Error & { hint?: string }).hint).toContain("Electron");
  });
});

describe("WindowNotFoundError", () => {
  it("uses WINDOW_NOT_FOUND code and includes the id", () => {
    const err = new WindowNotFoundError("win-42");
    expect(err.code).toBe("WINDOW_NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("win-42");
    expect(err.message).toContain("list_windows");
  });
});

describe("ElementNotFoundError", () => {
  it("uses ELEMENT_NOT_FOUND code and asks for fresh discovery", () => {
    const err = new ElementNotFoundError("Notes/win0/1");
    expect(err.code).toBe("ELEMENT_NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Notes/win0/1");
    expect(err.message).toContain("find_element");
  });
});

describe("InputSynthesisError", () => {
  it("uses INPUT_FAILED code and is retryable", () => {
    const err = new InputSynthesisError("key event rejected");
    expect(err.code).toBe("INPUT_FAILED");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("InputSynthesisError");
  });
});

describe("UnsupportedParameterError", () => {
  it("uses UNSUPPORTED_PARAMETER code and is non-retryable", () => {
    const err = new UnsupportedParameterError("xdotool required");
    expect(err.code).toBe("UNSUPPORTED_PARAMETER");
    expect(err.retryable).toBe(false);
  });
});

describe("CaptureError", () => {
  it("uses CAPTURE_FAILED code and is retryable", () => {
    const err = new CaptureError("screencapture timeout");
    expect(err.code).toBe("CAPTURE_FAILED");
    expect(err.retryable).toBe(true);
  });
});
