// sck-helper: ScreenCaptureKit per-window capture.
//
// Captures a window's TRUE composited bitmap from the window server — ignoring
// occlusion and background state. This is the macOS 14+ equivalent of what
// Codex Computer Use does (SCStream / SCShareableContent). Unlike `screencapture`
// (which grabs screen PIXELS, so occluders show through), ScreenCaptureKit reads
// the window's backing composited surface, which macOS maintains regardless of
// what is stacked on top of it. This is what makes true background operation
// possible: an Agent can SEE a window even while the user works in front of it.
//
// Requires macOS 14.0+ (SCScreenshotManager.captureImage). On older OS the
// helper reports an error and the TS caller falls back to the `screencapture`
// CLI path (which cannot defeat occlusion — documented limitation).
//
// stdin JSON (one line):  {"windowId": <CGWindowID>}
// stdout JSON (one line): {"imagePath": "<tmp png>"} | {"error": "..."}
//
// Build:
//   swiftc -O -o sck-helper main.swift \
//     -framework ScreenCaptureKit -framework CoreGraphics \
//     -framework AppKit -framework Foundation -framework ImageIO

import ScreenCaptureKit
import CoreGraphics
import AppKit
import Foundation
import ImageIO

struct Input: Decodable {
  let windowId: UInt32?
}

func out(_ s: String) {
  FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
  fflush(stdout)
}

guard let line = readLine(), let data = line.data(using: .utf8),
      let input = try? JSONDecoder().decode(Input.self, from: data),
      let wid = input.windowId else {
  out("{\"error\":\"expected {windowId}\"}")
  exit(1)
}

// ScreenCaptureKit requires a Core Graphics Server (CGS) connection, which a
// bare CLI does not have — it asserts CGS_REQUIRE_INIT on first SCK call.
// Touching NSApplication.shared lazily establishes the CGS connection without
// running a UI (no Dock icon, no run loop needed for the one-shot pattern below).
let _ = NSApplication.shared

// SCScreenshotManager.captureImage is async; this helper is a one-shot CLI, so
// bridge to synchronous with a dispatch semaphore.
let sem = DispatchSemaphore(value: 0)
var capturedImage: CGImage?
var capError: String?

if #available(macOS 14.0, *) {
  Task {
    defer { sem.signal() }
    let content: SCShareableContent
    do {
      // onScreenWindowsOnly:false so backgrounded/occluded windows are enumerable.
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
      capError = "shareable: \(error)"
      return
    }

    guard let win = content.windows.first(where: { $0.windowID == wid }) else {
      capError = "window \(wid) not found among \(content.windows.count) windows"
      return
    }

    let filter = SCContentFilter(desktopIndependentWindow: win)
    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.queueDepth = 3
    do {
      capturedImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    } catch {
      capError = "capture: \(error)"
    }
  }
  sem.wait()
} else {
  out("{\"error\":\"requires macOS 14+ (SCScreenshotManager)\"}")
  exit(1)
}

if let e = capError {
  out("{\"error\":\"\(e)\"}")
  exit(1)
}
guard let img = capturedImage else {
  out("{\"error\":\"no image captured\"}")
  exit(1)
}

let tmp = NSTemporaryDirectory() + "ucu-sck-\(UUID().uuidString).png"
guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: tmp) as CFURL, "public.png" as CFString, 1, nil) else {
  out("{\"error\":\"create image dest\"}")
  exit(1)
}
CGImageDestinationAddImage(dest, img, nil)
if !CGImageDestinationFinalize(dest) {
  out("{\"error\":\"finalize png\"}")
  exit(1)
}
out("{\"imagePath\":\"\(tmp)\"}")
