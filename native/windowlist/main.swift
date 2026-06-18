import CoreGraphics
import Foundation

// Window enumeration using CGWindowListCopyWindowInfo (WindowServer-level).
// Replaces JXA System Events enumeration which is slow (3-6s) and unreliable
// for Electron apps. CGWindowListCopyWindowInfo sees ALL windows regardless
// of whether the app exposes an AX tree.

struct WinInfo: Encodable {
    let id: String
    let title: String
    let processName: String
    let pid: Int32
    let bounds: Bounds
    let isOnScreen: Bool
    let windowNumber: Int
}

struct Bounds: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Output: Encodable {
    let windows: [WinInfo]
    let error: String?
}

// .optionAll includes windows on all Spaces + minimized windows. We filter by
// isOnScreen in the TS layer. Using .optionOnScreenOnly would miss windows on
// other Spaces or minimized ones, causing focus_app to fail for any background app.
let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    let out = Output(windows: [], error: "CGWindowListCopyWindowInfo returned nil")
    FileHandle.standardOutput.write(try! JSONEncoder().encode(out))
    exit(0)
}

var results: [WinInfo] = []

for info in windowList {
    guard let pid = info[kCGWindowOwnerPID as String] as? Int32,
          let windowNumber = info[kCGWindowNumber as String] as? Int,
          let layer = info[kCGWindowLayer as String] as? Int
    else { continue }

    // Skip non-normal layers (overlay, screen saver, etc.)
    if layer != 0 { continue }

    let boundsDict = info[kCGWindowBounds as String] as? [String: Any]
    let w = boundsDict?["Width"] as? Double ?? 0
    let h = boundsDict?["Height"] as? Double ?? 0
    if w == 0 || h == 0 { continue }

    let processName = (info[kCGWindowOwnerName as String] as? String) ?? ""
    if processName.isEmpty { continue }

    let title = (info[kCGWindowName as String] as? String) ?? ""
    let isOnScreen = (info[kCGWindowIsOnscreen as String] as? Bool) ?? true
    let x = (boundsDict?["X"] as? Double) ?? 0
    let y = (boundsDict?["Y"] as? Double) ?? 0

    results.append(WinInfo(
        id: "\(processName)/win\(windowNumber)",
        title: title,
        processName: processName,
        pid: pid,
        bounds: Bounds(x: x, y: y, width: w, height: h),
        isOnScreen: isOnScreen,
        windowNumber: windowNumber
    ))
}

let output = Output(windows: results, error: nil)
FileHandle.standardOutput.write(try! JSONEncoder().encode(output))
