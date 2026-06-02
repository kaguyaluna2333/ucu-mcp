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
    case "darwin":
      await execFileAsync("screencapture", ["-x", outFile]);
      break;
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
 * Capture a specific window by its ID and return a base64-encoded PNG string.
 *
 * - macOS: windowId is the CGWindowID (use `osascript -e 'tell app "System Events" ...'` or Quartz).
 * - Linux: windowId is the X11 window id (xdotool style).
 * - Windows: windowId is the native HWND (hex or decimal).
 */
export async function captureWindow(windowId: number | string, options?: ScreenshotEncodeOptions): Promise<string> {
  const platform = getPlatform();
  const outFile = await tempImagePath("png");

  switch (platform) {
    case "darwin":
      // screencapture -l<windowId> captures a specific window
      await execFileAsync("screencapture", ["-x", `-l${windowId}`, outFile]);
      break;
    case "linux": {
      // Use import from xdotool / xwd + convert
      const wid = String(windowId);
      // xwd -> convert to png via ImageMagick
      const xwdFile = outFile.replace(/\.png$/, ".xwd");
      await execFileAsync("xwd", ["-id", wid, "-out", xwdFile]);
      await execFileAsync("convert", [xwdFile, outFile]);
      await unlink(xwdFile).catch(() => {});
      break;
    }
    case "win32":
      // PowerShell: capture a specific window handle
      await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Drawing; Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
public class WinCapture {
  [DllImport("user32.dll")] public static extern IntPtr GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static void CaptureWindow(IntPtr hWnd, string path) {
    RECT r; GetWindowRect(hWnd, out r);
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0) throw new Exception("Invalid window size");
    var bmp = new Bitmap(w, h);
    var g = Graphics.FromImage(bmp);
    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h));
    bmp.Save(path);
    g.Dispose(); bmp.Dispose();
  }
}
'@; [WinCapture]::CaptureWindow([IntPtr]${windowId}, '${outFile.replace(/'/g, "''").replace(/\\/g, "\\\\")}')`,
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
