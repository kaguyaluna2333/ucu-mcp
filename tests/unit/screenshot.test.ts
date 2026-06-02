import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";

const execFileMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const unlinkMock = vi.hoisted(() => vi.fn());
const randomUUIDMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
  unlink: unlinkMock,
}));

vi.mock("node:crypto", () => ({
  randomUUID: randomUUIDMock,
}));

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
  });
}

describe("screenshot encoding options", () => {
  const originalPlatform = process.platform;
  const capturedPath = `${tmpdir()}/ucu-screenshot-capture.png`;
  const resizedPath = `${tmpdir()}/ucu-screenshot-resized.png`;
  const encodedPath = `${tmpdir()}/ucu-screenshot-encoded.jpg`;

  beforeEach(() => {
    vi.resetModules();
    setPlatform("darwin");
    randomUUIDMock
      .mockReset()
      .mockReturnValueOnce("capture")
      .mockReturnValueOnce("resized")
      .mockReturnValueOnce("encoded");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return {};
    });
    readFileMock.mockImplementation(async (filePath: string) => Buffer.from(`bytes:${filePath}`));
    unlinkMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.clearAllMocks();
  });

  it("returns the captured PNG without invoking sips when no encode options are set", async () => {
    const { captureFullScreen } = await import("../../src/utils/screenshot.js");

    const result = await captureFullScreen();

    expect(result).toBe(Buffer.from(`bytes:${capturedPath}`).toString("base64"));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "screencapture",
      ["-x", capturedPath],
      expect.any(Function),
    );
    expect(readFileMock).toHaveBeenCalledWith(capturedPath);
    expect(unlinkMock).toHaveBeenCalledWith(capturedPath);
  });

  it("resizes before converting to JPEG when maxWidth and format are provided", async () => {
    const { captureFullScreen } = await import("../../src/utils/screenshot.js");

    const result = await captureFullScreen({ format: "jpeg", maxWidth: 640 });

    expect(result).toBe(Buffer.from(`bytes:${encodedPath}`).toString("base64"));
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "screencapture",
      ["-x", capturedPath],
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/sips",
      ["-Z", "640", capturedPath, "--out", resizedPath],
      { timeout: 15000 },
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "/usr/bin/sips",
      ["-s", "format", "jpeg", resizedPath, "--out", encodedPath],
      { timeout: 15000 },
      expect.any(Function),
    );
    expect(readFileMock).toHaveBeenCalledWith(encodedPath);
    expect(unlinkMock).toHaveBeenCalledWith(capturedPath);
    expect(unlinkMock).toHaveBeenCalledWith(resizedPath);
    expect(unlinkMock).toHaveBeenCalledWith(encodedPath);
  });

  it("rounds maxWidth before passing it to sips", async () => {
    const { captureFullScreen } = await import("../../src/utils/screenshot.js");

    await captureFullScreen({ maxWidth: 1279.6 });

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/sips",
      ["-Z", "1280", capturedPath, "--out", resizedPath],
      { timeout: 15000 },
      expect.any(Function),
    );
  });
});
