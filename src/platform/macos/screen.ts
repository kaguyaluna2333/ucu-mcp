import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MacOSPlatform } from "./base.js";
import type { ScreenRegion, ScreenSize, ScreenshotOptions, OcrResult } from "../base.js";
import { captureFullScreen, captureRegion } from "../../utils/screenshot.js";
import { WindowNotFoundError, CaptureError } from "../../util/errors.js";
import { logger } from "../../util/logger.js";
import { rethrowCaptureError, errorMessage } from "./helpers.js";

export async function screenshot(this: MacOSPlatform, _display?: number, region?: ScreenRegion, options?: ScreenshotOptions): Promise<Buffer> {
  try {
    const base64 = region
      ? await captureRegion(region.x, region.y, region.width, region.height, options)
      : await captureFullScreen(options);
    return Buffer.from(base64, "base64");
  } catch (error) {
    rethrowCaptureError(error, region ? "capture region" : "capture full screen");
  }
}

export async function screenshotWindow(this: MacOSPlatform, windowId: string, options?: ScreenshotOptions): Promise<Buffer> {
  const win = (await this.listWindows(true)).find((w) => w.id === windowId);
  if (!win) {
    throw new WindowNotFoundError(windowId);
  }
  return this.screenshot(undefined, win.bounds, options);
}

export function getScreenSize(this: MacOSPlatform, display?: number): ScreenSize {
  const idx = display ?? 0;
  const now = Date.now();
  if (
    this.screenSizeCache &&
    this.screenSizeCache.display === idx &&
    now - this.screenSizeCache.cachedAt <= this.screenSizeCacheTtlMs
  ) {
    return this.screenSizeCache.size;
  }

  try {
    const out = execFileSync("osascript", [
      "-l", "JavaScript",
      "-e",
      `ObjC.import('AppKit');
      var screens = $.NSScreen.screens;
      var idx = ${idx};
      if (idx < 0 || idx >= screens.count) idx = 0;
      var screen = $(screens).objectAtIndex(idx);
      var frame = screen.frame;
      var scaleFactor = screen.backingScaleFactor;
      JSON.stringify({width:Math.round(frame.size.width),height:Math.round(frame.size.height),scaleFactor:scaleFactor})`,
    ], { encoding: "utf-8", timeout: 5000 }).trim();
    const size = JSON.parse(out) as ScreenSize;
    this.screenSizeCache = { display: idx, cachedAt: Date.now(), size };
    return size;
  } catch (error) {
    logger.warn("getScreenSize failed, using fallback", { error: errorMessage(error) });
    return { width: 1920, height: 1080, scaleFactor: 2, estimated: true };
  }
}

export function isScreenLocked(this: MacOSPlatform): boolean {
  try {
    const out = execFileSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return /"IOConsoleLocked"\s*=\s*Yes/.test(out);
  } catch {
    // Fail-closed: if we can't determine lock state, assume locked
    logger.warn("isScreenLocked check failed, assuming locked");
    return true;
  }
}

export async function ocr(this: MacOSPlatform, display?: number, region?: ScreenRegion): Promise<OcrResult> {
  const buf = await this.screenshot(display, region);

  const { writeFile, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tmpPath = join(tmpdir(), `ucu-ocr-${randomUUID()}.png`);
  await writeFile(tmpPath, buf);

  try {
    const screenSize = this.getScreenSize(display);
    const scaleFactor = screenSize.scaleFactor ?? 2;

    const nativeResult = await ocrNative(tmpPath, scaleFactor, region);
    if (nativeResult) return nativeResult;

    return await ocrJxa(tmpPath, screenSize, scaleFactor, region);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

async function ocrNative(tmpPath: string, scaleFactor: number, region?: ScreenRegion): Promise<OcrResult | null> {
  const screenDirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // npm prod: screen.js 编译落在 dist/src/platform/macos/（4 级深），到包根需 4 级 ../
    join(screenDirname, "..", "..", "..", "..", "native", "ocr", "ocr-helper"),
    // dev: screen.ts 在 src/platform/macos/（3 级深），3 级到包根
    join(screenDirname, "..", "..", "..", "native", "ocr", "ocr-helper"),
    join(screenDirname, "..", "..", "native", "ocr", "ocr-helper"),
    join(process.cwd(), "native", "ocr", "ocr-helper"),
  ];

  let binaryPath: string | undefined;
  for (const p of candidates) {
    if (existsSync(p)) { binaryPath = p; break; }
  }
  if (!binaryPath) return null;

  try {
    const input = JSON.stringify({ imagePath: tmpPath });
    const out = execFileSync(binaryPath, [], {
      input,
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
    const parsed = JSON.parse(out);
    if (parsed.error) return null;

    const elements = parsed.elements.map((el: any) => ({
      text: el.text,
      x: Math.round(el.x / scaleFactor) + (region ? region.x : 0),
      y: Math.round(el.y / scaleFactor) + (region ? region.y : 0),
      width: Math.round(el.width / scaleFactor),
      height: Math.round(el.height / scaleFactor),
      confidence: el.confidence,
    }));

    return { elements, fullText: parsed.fullText };
  } catch {
    return null;
  }
}

async function ocrJxa(tmpPath: string, screenSize: ScreenSize, scaleFactor: number, region: ScreenRegion | undefined): Promise<OcrResult> {
  const pathLiteral = JSON.stringify(tmpPath);
  const jxaScript = `
    function run() {
      ObjC.import('Vision');
      ObjC.import('AppKit');
      ObjC.import('Foundation');
      var path = ${pathLiteral};
      var fm = $.NSFileManager.defaultManager;
      if (!fm.fileExistsAtPath(path)) {
        return JSON.stringify({error: "Failed to load screenshot image", elements: [], fullText: ""});
      }
      var url = $.NSURL.fileURLWithPath(path);
      var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $());
      if (!handler) {
        return JSON.stringify({error: "Failed to get CGImage from screenshot", elements: [], fullText: ""});
      }
      var request = $.VNRecognizeTextRequest.alloc.init;
      request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
      request.usesLanguageCorrection = true;
      var performError = Ref();
      var success = handler.performRequestsError($([request]), performError);
      if (!success) {
        return JSON.stringify({error: "OCR request failed", elements: [], fullText: ""});
      }
      var results = request.results;
      var image = $.NSImage.alloc.initWithContentsOfURL(url);
      if (!image || $(image.representations()).count === 0) {
        return JSON.stringify({error: "Failed to load screenshot image", elements: [], fullText: ""});
      }
      var rep = image.representations().objectAtIndex(0);
      var imgWidth = rep.pixelsWide;
      var imgHeight = rep.pixelsHigh;
      var elements = [];
      var fullTextParts = [];
      for (var i = 0; i < results.count; i++) {
        var obs = $(results).objectAtIndex(i);
        var candidates = obs.topCandidates(1);
        if (candidates && $(candidates).count > 0) {
          var candidate = $(candidates).objectAtIndex(0);
          var text = ObjC.unwrap(candidate.string);
          var confidence = candidate.confidence;
          var bbox = obs.boundingBox;
          var bx = bbox.origin.x * imgWidth;
          var by = (1 - bbox.origin.y - bbox.size.height) * imgHeight;
          var bw = bbox.size.width * imgWidth;
          var bh = bbox.size.height * imgHeight;
          elements.push({text:text,x:Math.round(bx),y:Math.round(by),width:Math.round(bw),height:Math.round(bh),confidence:confidence});
          fullTextParts.push(text);
        }
      }
      return JSON.stringify({elements:elements,fullText:fullTextParts.join("\\n"),error:null});
    }
    run();
  `;
  const out = execFileSync("osascript", ["-l", "JavaScript", "-e", jxaScript], { encoding: "utf-8", timeout: 30000 }).trim();
  const parsed = JSON.parse(out);
  if (parsed.error) {
    const hint = parsed.error === "Failed to load screenshot image"
      ? " (the screenshot file is empty or unreadable — Screen Recording permission is most likely missing; run `doctor` and grant Screen Recording to the host terminal, then retry)"
      : parsed.error === "Failed to get CGImage from screenshot"
        ? " (the screenshot could not be decoded — likely an empty capture; check Screen Recording permission)"
        : "";
    throw new CaptureError(`ocr failed: ${parsed.error}${hint}`);
  }

  const elements = parsed.elements.map((el: any) => ({
    text: el.text,
    x: Math.round(el.x / scaleFactor) + (region ? region.x : 0),
    y: Math.round(el.y / scaleFactor) + (region ? region.y : 0),
    width: Math.round(el.width / scaleFactor),
    height: Math.round(el.height / scaleFactor),
    confidence: el.confidence,
  }));
  return { elements, fullText: parsed.fullText };
}
