import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Platform = "darwin" | "linux" | "win32";
export interface ScreenshotEncodeOptions {
  format?: "png" | "jpeg";
  maxWidth?: number;
  /** Display index to capture (full-screen mode only). macOS: passed as `screencapture -D`. */
  display?: number;
}

function getPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new Error(`Unsupported platform: ${p}`);
}

async function tempImagePath(extension = "png"): Promise<string> {
  return join(tmpdir(), `ucu-screenshot-${randomUUID()}.${extension}`);
}

async function readAndClean(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  await unlink(filePath).catch(() => {});
  return buf.toString("base64");
}

async function encodeForClient(filePath: string, options: ScreenshotEncodeOptions = {}): Promise<string> {
  const platform = getPlatform();
  const targetFormat = options.format ?? "png";
  const maxWidth = options.maxWidth && options.maxWidth > 0 ? Math.round(options.maxWidth) : undefined;

  if (platform !== "darwin" || (!maxWidth && targetFormat === "png")) {
    return readAndClean(filePath);
  }

  const cleanup = [filePath];
  let currentPath = filePath;

  try {
    if (maxWidth) {
      const resizedPath = await tempImagePath(extname(currentPath).replace(".", "") || "png");
      cleanup.push(resizedPath);
      await execFileAsync("/usr/bin/sips", ["-Z", String(maxWidth), currentPath, "--out", resizedPath], { timeout: 15000 });
      currentPath = resizedPath;
    }

    if (targetFormat === "jpeg") {
      const jpegPath = await tempImagePath("jpg");
      cleanup.push(jpegPath);
      await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", currentPath, "--out", jpegPath], { timeout: 15000 });
      currentPath = jpegPath;
    }

    const buf = await readFile(currentPath);
    return buf.toString("base64");
  } finally {
    await Promise.all(cleanup.map((path) => unlink(path).catch(() => {})));
  }
}

/**
 * Capture the full screen and return a base64-encoded PNG string.
 */
export async function captureFullScreen(options?: ScreenshotEncodeOptions): Promise<string> {
  const platform = getPlatform();
  const outFile = await tempImagePath("png");

  switch (platform) {
    case "darwin": {
      const args = ["-x"];
      // screencapture -D is a 1-based ordinal (-D 1 = main); the tool schema's
      // `display` is a 0-based NSScreen index (matching getScreenSize/ocr), so +1.
      if (typeof options?.display === "number") args.push(`-D${options.display + 1}`);
      args.push(outFile);
      await execFileAsync("screencapture", args);
      break;
    }
    case "linux":
      await execFileAsync("scrot", [outFile]);
      break;
    case "win32":
      await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${outFile.replace(/'/g, "''").replace(/\\/g, "\\\\")}'); $g.Dispose(); $bmp.Dispose() }`,
      ]);
      break;
  }

  return encodeForClient(outFile, options);
}

/**
 * Capture a specific screen region and return a base64-encoded PNG string.
 */
export async function captureRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  options?: ScreenshotEncodeOptions,
): Promise<string> {
  const platform = getPlatform();
  const outFile = await tempImagePath("png");

  switch (platform) {
    case "darwin":
      // screencapture -R<x,y,w,h>
      await execFileAsync("screencapture", ["-x", `-R${x},${y},${width},${height}`, outFile]);
      break;
    case "linux":
      // scrot with --select for region, but that is interactive.
      // Use import: +crop instead
      await execFileAsync("import", [
        "-window", "root",
        "-crop", `${width}x${height}+${x}+${y}`,
        outFile,
      ]);
      break;
    case "win32":
      await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(${width}, ${height}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${x}, ${y}, 0, 0, [System.Drawing.Size]::new(${width}, ${height})); $bmp.Save('${outFile.replace(/'/g, "''").replace(/\\/g, "\\\\")}'); $g.Dispose(); $bmp.Dispose()`,
      ]);
      break;
  }

  return encodeForClient(outFile, options);
}
