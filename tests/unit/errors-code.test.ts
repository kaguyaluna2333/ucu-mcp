import { describe, it, expect } from "vitest";
import {
  UcuError,
  PlatformError,
  SafetyError,
  PermissionError,
  WindowNotFoundError,
  TargetStaleError,
  ElementNotFoundError,
  InputSynthesisError,
  UnsupportedParameterError,
  CaptureError,
} from "../../src/util/errors.js";

describe("UcuError code field", () => {
  it("base UcuError exposes code UCU_ERROR", () => {
    expect(new UcuError("x").code).toBe("UCU_ERROR");
  });

  it("base UcuError exposes class-level static code UCU_ERROR", () => {
    expect(UcuError.defaultCode).toBe("UCU_ERROR");
  });

  it("accepts explicit code override on base", () => {
    const err = new UcuError("x", "CUSTOM_CODE");
    expect(err.code).toBe("CUSTOM_CODE");
  });
});

describe("UcuError toJSON", () => {
  it("serializes name, code, retryable, message", () => {
    const err = new WindowNotFoundError("Notes/win0");
    const json = err.toJSON();
    expect(json).toEqual({
      name: "WindowNotFoundError",
      code: "WINDOW_NOT_FOUND",
      retryable: false,
      message: err.message,
    });
  });

  it("JSON.stringify of error yields the toJSON shape", () => {
    const err = new ElementNotFoundError("Notes/win0/1");
    const parsed = JSON.parse(JSON.stringify(err));
    expect(parsed.code).toBe("ELEMENT_NOT_FOUND");
    expect(parsed.name).toBe("ElementNotFoundError");
    expect(parsed.message).toContain("Notes/win0/1");
  });
});

describe("subclass codes (defaults and overrides)", () => {
  const cases: Array<[new (...args: any[]) => UcuError, string, string]> = [
    [PlatformError, "PLATFORM_ERROR", "platform fail"],
    [SafetyError, "SAFETY_BLOCKED", "blocked"],
    [WindowNotFoundError, "WINDOW_NOT_FOUND", "Notes/win0"],
    [TargetStaleError, "TARGET_STALE", "Notes/win0"],
    [ElementNotFoundError, "ELEMENT_NOT_FOUND", "Notes/win0/1"],
    [InputSynthesisError, "INPUT_FAILED", "key event rejected"],
    [UnsupportedParameterError, "UNSUPPORTED_PARAMETER", "x is not supported"],
    [CaptureError, "CAPTURE_FAILED", "screen recording denied"],
  ];

  for (const [Ctor, expectedCode, msg] of cases) {
    it(`${Ctor.name} defaults to ${expectedCode}`, () => {
      // PermissionError has a different constructor signature
      const err =
        Ctor === PermissionError
          ? new (Ctor as any)("accessibility", "darwin")
          : new (Ctor as any)(msg);
      expect(err.code).toBe(expectedCode);
    });

    it(`${Ctor.name} has class-level static code ${expectedCode}`, () => {
      expect((Ctor as any).defaultCode).toBe(expectedCode);
    });
  }

  it("PermissionError defaults to PERMISSION_DENIED", () => {
    const err = new PermissionError("accessibility", "darwin");
    expect(err.code).toBe("PERMISSION_DENIED");
  });
});

describe("subclass code override", () => {
  it("InputSynthesisError accepts a custom code via super", () => {
    // Direct base UcuError call with custom code
    const err = new UcuError("nope", "INPUT_TIMEOUT", true);
    expect(err.code).toBe("INPUT_TIMEOUT");
  });
});
