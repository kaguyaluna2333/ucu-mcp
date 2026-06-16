// skylight-helper: per-process event posting via private SkyLight SPIs.
//
// Posts mouse/keyboard events to a SPECIFIC process (by pid) without moving the
// global cursor or stealing foreground — matching Codex computer-use behavior.
// Uses SLEventPostToPid (private SkyLight) for mouse, CGEventPostToPid (public)
// for keyboard. Falls back to HID-tap posting (which moves the cursor) when the
// target is frontmost/canvas-app or when SPIs are unavailable.
//
// stdin/stdout JSON protocol mirrors cgevent-helper (line-oriented).

import CoreGraphics
import Foundation
import AppKit

// MARK: - SkyLight SPI loading

private let RTLD_DEFAULT = UnsafeMutableRawPointer(bitPattern: -2)!

// Force-load SkyLight so its symbols register in the global namespace.
_ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)

private func sym<T>(_ name: String, as _: T.Type) -> T? {
    guard let p = dlsym(RTLD_DEFAULT, name) else { return nil }
    return unsafeBitCast(p, to: T.self)
}

// void SLEventPostToPid(pid_t, CGEventRef)
private typealias SLEventPostToPidFn = @convention(c) (pid_t, CGEvent) -> Void
private let slPostToPid: SLEventPostToPidFn? = sym("SLEventPostToPid", as: SLEventPostToPidFn.self)

// void CGEventSetWindowLocation(CGEventRef, CGPoint)  — private
private typealias SetWindowLocFn = @convention(c) (CGEvent, CGPoint) -> Void
private let setWindowLoc: SetWindowLocFn? = sym("CGEventSetWindowLocation", as: SetWindowLocFn.self)

// void SLEventSetIntegerValueField(CGEventRef, uint32_t, int64_t)  — private
private typealias SetIntFieldFn = @convention(c) (CGEvent, UInt32, Int64) -> Void
private let setIntField: SetIntFieldFn? = sym("SLEventSetIntegerValueField", as: SetIntFieldFn.self)

// CGSConnectionID CGSMainConnectionID(void)
private typealias ConnIDFn = @convention(c) () -> UInt32
private let mainConnID: ConnIDFn? = sym("CGSMainConnectionID", as: ConnIDFn.self)

// CGError SLSGetWindowOwner(CGSConnectionID, CGWindowID, CGSConnectionID*)
private typealias GetWindowOwnerFn = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
private let getWindowOwner: GetWindowOwnerFn? = sym("SLSGetWindowOwner", as: GetWindowOwnerFn.self)

// OSStatus SLSGetConnectionPSN(CGSConnectionID, ProcessSerialNumber*)
private typealias GetConnPSNFn = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
private let getConnPSN: GetConnPSNFn? = sym("SLSGetConnectionPSN", as: GetConnPSNFn.self)

// OSStatus _SLPSGetFrontProcess(ProcessSerialNumber*)
private typealias GetFrontPSNFn = @convention(c) (UnsafeMutableRawPointer) -> Int32
private let getFrontPSN: GetFrontPSNFn? = sym("_SLPSGetFrontProcess", as: GetFrontPSNFn.self)

// OSStatus SLPSPostEventRecordTo(ProcessSerialNumber*, uint8_t*)
private typealias PostEventRecFn = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
private let postEventRec: PostEventRecFn? = sym("SLPSPostEventRecordTo", as: PostEventRecFn.self)

/// True if all SPIs needed for per-process mouse posting are present.
private let skylightMouseAvailable: Bool = (slPostToPid != nil)

// MARK: - I/O helpers

struct Input: Decodable {
    let command: String
    let pid: Int32?
    let windowNumber: Int?
    let x: Double?
    let y: Double?
    let fromX: Double?
    let fromY: Double?
    let toX: Double?
    let toY: Double?
    let button: String?
    let durationMs: Int?
    let deltaX: Int?
    let deltaY: Int?
    let keyCode: Int?
    let flags: Int64?
    let keys: [KeyEntry]?
    struct KeyEntry: Decodable { let code: Int; let shift: Bool? }
}

func out(_ json: String) {
    FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!)
    fflush(stdout)
}

func btn(_ s: String?) -> CGMouseButton {
    switch s { case "right": return .right; case "middle": return .center; default: return .left }
}
func downT(_ b: CGMouseButton) -> CGEventType {
    switch b { case .right: return .rightMouseDown; case .center: return .otherMouseDown; default: return .leftMouseDown }
}
func upT(_ b: CGMouseButton) -> CGEventType {
    switch b { case .right: return .rightMouseUp; case .center: return .otherMouseUp; default: return .leftMouseUp }
}
func dragT(_ b: CGMouseButton) -> CGEventType {
    switch b { case .right: return .rightMouseDragged; case .center: return .otherMouseDragged; default: return .leftMouseDragged }
}

// MARK: - Event construction & posting

/// Build a mouse CGEvent via the NSEvent bridge (raw CGEventCreateMouseEvent events are
/// filtered by Chromium's renderer IPC). Returns nil on failure.
func makeMouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton,
                    clickCount: Int = 1, windowNumber: Int = 0) -> CGEvent? {
    let nsType: NSEvent.EventType
    switch type {
    case .leftMouseDown: nsType = .leftMouseDown
    case .leftMouseUp: nsType = .leftMouseUp
    case .rightMouseDown: nsType = .rightMouseDown
    case .rightMouseUp: nsType = .rightMouseUp
    case .otherMouseDown: nsType = .otherMouseDown
    case .otherMouseUp: nsType = .otherMouseUp
    case .leftMouseDragged: nsType = .leftMouseDragged
    case .rightMouseDragged: nsType = .rightMouseDragged
    case .otherMouseDragged: nsType = .otherMouseDragged
    case .mouseMoved: nsType = .mouseMoved
    default: return nil
    }
    guard let ns = NSEvent.mouseEvent(
        with: nsType, location: point, modifierFlags: [],
        timestamp: 0, windowNumber: windowNumber, context: nil,
        eventNumber: 0, clickCount: clickCount, pressure: (type == .mouseMoved) ? 0 : 1.0
    ), let cg = ns.cgEvent else { return nil }
    return cg
}

/// Stamp a mouse event with the fields Chromium's synthetic-event filter requires,
/// then post it to the target pid via SLEventPostToPid (no global cursor move).
func postPerPid(_ event: CGEvent, pid: Int32, at point: CGPoint, windowNumber: Int) {
    event.location = point
    event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    if windowNumber > 0 {
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowNumber))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowNumber))
    }
    // Private SPIs: window-local point + Chromium pid latch (field 40).
    setWindowLoc?(event, point)
    setIntField?(event, 40, Int64(pid))
    event.timestamp = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    slPostToPid?(pid, event)
}

/// HID-tap fallback (moves the cursor). Used for frontmost/canvas apps where
/// per-pid posting is filtered.
func postHidTap(_ event: CGEvent) {
    event.post(tap: CGEventTapLocation.cghidEventTap)
}

/// True if the target pid is the frontmost app (canvas/GPU apps filter per-pid
/// routes — must use HID-tap there).
func isFrontmost(_ pid: Int32) -> Bool {
    return NSRunningApplication(processIdentifier: pid)?.isActive == true
}

// MARK: - Focus-without-raise (SLPSPostEventRecordTo)

/// Flip the target's AppKit-active state without raising its window (no Space switch).
func focusWithoutRaise(pid: Int32, windowID: Int) {
    guard let postRec = postEventRec, let frontFn = getFrontPSN else { return }
    // Resolve target PSN via window owner.
    guard let connFn = mainConnID, let ownerFn = getWindowOwner, let psnFn = getConnPSN,
          windowID > 0 else { return }
    var prevPSN = [UInt32](repeating: 0, count: 2)
    var targetPSN = [UInt32](repeating: 0, count: 2)
    let prevOk = prevPSN.withUnsafeMutableBytes { raw in frontFn(raw.baseAddress!) != 0 }
    if prevOk {
        let cid = connFn()
        var ownerCid: UInt32 = 0
        guard ownerFn(cid, UInt32(windowID), &ownerCid) == 0 else { return }
        guard psnFn(ownerCid, &targetPSN) == 0 else { return }
    } else {
        return
    }
    var buf = [UInt8](repeating: 0, count: 0xF8) // 248 bytes
    buf[0x04] = 0xF8
    buf[0x08] = 0x0D
    let wid = UInt32(windowID)
    buf[0x3C] = UInt8(wid & 0xFF); buf[0x3D] = UInt8((wid >> 8) & 0xFF)
    buf[0x3E] = UInt8((wid >> 16) & 0xFF); buf[0x3F] = UInt8((wid >> 24) & 0xFF)
    // Defocus previous front.
    buf[0x8A] = 0x02
    _ = prevPSN.withUnsafeBytes { psnRaw in buf.withUnsafeBufferPointer { bp in postRec(psnRaw.baseAddress!, bp.baseAddress!) } }
    // Focus target.
    buf[0x8A] = 0x01
    _ = targetPSN.withUnsafeBytes { psnRaw in buf.withUnsafeBufferPointer { bp in postRec(psnRaw.baseAddress!, bp.baseAddress!) } }
}

// MARK: - Commands

func doClick(_ p: Input) -> String {
    guard let pid = p.pid, pid > 0 else { return "{\"error\":\"no pid\"}" }
    let loc = CGPoint(x: p.x ?? 0, y: p.y ?? 0)
    let b = btn(p.button)
    let winNum = p.windowNumber ?? 0
    // Canvas/frontmost apps filter per-pid routes → HID-tap fallback.
    if !skylightMouseAvailable || isFrontmost(pid) {
        guard let dn = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: loc, mouseButton: b),
              let up = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: loc, mouseButton: b)
        else { return "{\"error\":\"fail\"}" }
        postHidTap(dn); postHidTap(up)
        return "{\"ok\":true,\"method\":\"hid-tap\"}"
    }
    focusWithoutRaise(pid: pid, windowID: winNum)
    // Leading mouseMoved at target (cursor-state primer).
    if let mv = makeMouseEvent(.mouseMoved, at: loc, button: b, windowNumber: winNum) {
        postPerPid(mv, pid: pid, at: loc, windowNumber: winNum); usleep(15_000)
    }
    // Off-screen primer click @ (-1,-1) — satisfies Chromium user-activation gate.
    let off = CGPoint(x: -1, y: -1)
    if let pd = makeMouseEvent(.leftMouseDown, at: off, button: .left, windowNumber: winNum),
       let pu = makeMouseEvent(.leftMouseUp, at: off, button: .left, windowNumber: winNum) {
        postPerPid(pd, pid: pid, at: off, windowNumber: winNum); usleep(1_000)
        postPerPid(pu, pid: pid, at: off, windowNumber: winNum); usleep(100_000)
    }
    // Target click.
    guard let dn = makeMouseEvent(downT(b), at: loc, button: b, windowNumber: winNum),
          let up = makeMouseEvent(upT(b), at: loc, button: b, windowNumber: winNum)
    else { return "{\"error\":\"fail\"}" }
    postPerPid(dn, pid: pid, at: loc, windowNumber: winNum); usleep(1_000)
    postPerPid(up, pid: pid, at: loc, windowNumber: winNum)
    return "{\"ok\":true,\"method\":\"per-pid\"}"
}

func doDoubleClick(_ p: Input) -> String {
    guard let pid = p.pid, pid > 0 else { return "{\"error\":\"no pid\"}" }
    let loc = CGPoint(x: p.x ?? 0, y: p.y ?? 0)
    let b = btn(p.button)
    let winNum = p.windowNumber ?? 0
    if !skylightMouseAvailable || isFrontmost(pid) {
        return hidTapDouble(loc: loc, b: b)
    }
    focusWithoutRaise(pid: pid, windowID: winNum)
    for state in [1, 2] {
        guard let dn = makeMouseEvent(downT(b), at: loc, button: b, clickCount: state, windowNumber: winNum),
              let up = makeMouseEvent(upT(b), at: loc, button: b, clickCount: state, windowNumber: winNum)
        else { return "{\"error\":\"fail\"}" }
        postPerPid(dn, pid: pid, at: loc, windowNumber: winNum); usleep(1_000)
        postPerPid(up, pid: pid, at: loc, windowNumber: winNum)
        if state == 1 { usleep(80_000) }
    }
    return "{\"ok\":true,\"method\":\"per-pid\"}"
}

func hidTapDouble(loc: CGPoint, b: CGMouseButton) -> String {
    guard let d1 = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: loc, mouseButton: b),
          let u1 = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: loc, mouseButton: b),
          let d2 = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: loc, mouseButton: b),
          let u2 = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: loc, mouseButton: b)
    else { return "{\"error\":\"fail\"}" }
    d1.setIntegerValueField(.mouseEventClickState, value: 1); u1.setIntegerValueField(.mouseEventClickState, value: 1)
    d2.setIntegerValueField(.mouseEventClickState, value: 2); u2.setIntegerValueField(.mouseEventClickState, value: 2)
    postHidTap(d1); postHidTap(u1); postHidTap(d2); postHidTap(u2)
    return "{\"ok\":true,\"method\":\"hid-tap\"}"
}

func doMove(_ p: Input) -> String {
    guard let pid = p.pid, pid > 0, skylightMouseAvailable, !isFrontmost(pid) else {
        let loc = CGPoint(x: p.x ?? 0, y: p.y ?? 0)
        guard let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: loc, mouseButton: .left)
        else { return "{\"error\":\"fail\"}" }
        postHidTap(ev); return "{\"ok\":true,\"method\":\"hid-tap\"}"
    }
    let loc = CGPoint(x: p.x ?? 0, y: p.y ?? 0)
    let winNum = p.windowNumber ?? 0
    if let ev = makeMouseEvent(.mouseMoved, at: loc, button: .left, windowNumber: winNum) {
        postPerPid(ev, pid: pid, at: loc, windowNumber: winNum)
        return "{\"ok\":true,\"method\":\"per-pid\"}"
    }
    return "{\"error\":\"fail\"}"
}

func doDrag(_ p: Input) -> String {
    guard let pid = p.pid, pid > 0 else { return "{\"error\":\"no pid\"}" }
    let from = CGPoint(x: p.fromX ?? 0, y: p.fromY ?? 0)
    let to = CGPoint(x: p.toX ?? 0, y: p.toY ?? 0)
    let ms = p.durationMs ?? 300; let b = btn(p.button)
    let winNum = p.windowNumber ?? 0
    let steps = max(2, min(60, Int(ceil(Double(ms) / 16.0))))
    let delay = max(0, (ms * 1000) / steps)
    if !skylightMouseAvailable || isFrontmost(pid) {
        guard let dn = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: from, mouseButton: b)
        else { return "{\"error\":\"fail\"}" }
        postHidTap(dn)
        for n in 1...steps {
            let t = Double(n) / Double(steps)
            let pt = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            if let ev = CGEvent(mouseEventSource: nil, mouseType: dragT(b), mouseCursorPosition: pt, mouseButton: b) { postHidTap(ev) }
            if delay > 0 && n < steps { usleep(UInt32(delay)) }
        }
        if let up = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: to, mouseButton: b) { postHidTap(up) }
        return "{\"ok\":true,\"method\":\"hid-tap\"}"
    }
    focusWithoutRaise(pid: pid, windowID: winNum)
    guard let dn = makeMouseEvent(downT(b), at: from, button: b, windowNumber: winNum)
    else { return "{\"error\":\"fail\"}" }
    postPerPid(dn, pid: pid, at: from, windowNumber: winNum)
    for n in 1...steps {
        let t = Double(n) / Double(steps)
        let pt = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        if let ev = makeMouseEvent(dragT(b), at: pt, button: b, windowNumber: winNum) {
            postPerPid(ev, pid: pid, at: pt, windowNumber: winNum)
        }
        if delay > 0 && n < steps { usleep(UInt32(delay)) }
    }
    if let up = makeMouseEvent(upT(b), at: to, button: b, windowNumber: winNum) {
        postPerPid(up, pid: pid, at: to, windowNumber: winNum)
    }
    return "{\"ok\":true,\"method\":\"per-pid\"}"
}

func doScroll(_ p: Input) -> String {
    // Scroll events use CGEventCreateScrollWheelEvent; per-pid scroll posting is
    // unreliable across app types, so we route via HID-tap but still report method.
    let dy = Int32(-(p.deltaY ?? 0)); let dx = Int32(p.deltaX ?? 0)
    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    else { return "{\"error\":\"fail\"}" }
    // Best-effort per-pid if we have a pid; scroll doesn't move the cursor noticeably anyway.
    if let pid = p.pid, pid > 0, slPostToPid != nil, !isFrontmost(pid) {
        slPostToPid?(pid, ev)
        return "{\"ok\":true,\"method\":\"per-pid\"}"
    }
    postHidTap(ev)
    return "{\"ok\":true,\"method\":\"hid-tap\"}"
}

func doPressKey(_ p: Input) -> String {
    guard let pid = p.pid, pid > 0 else { return "{\"error\":\"no pid\"}" }
    let code = UInt16(p.keyCode ?? 0); let flags = CGEventFlags(rawValue: UInt64(p.flags ?? 0))
    guard let dn = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { return "{\"error\":\"fail\"}" }
    dn.flags = flags; up.flags = flags
    // Keyboard: public CGEventPostToPid is sufficient (no SkyLight needed).
    dn.postToPid(pid); up.postToPid(pid)
    return "{\"ok\":true,\"method\":\"per-pid\"}"
}

func doTypeBatch(_ p: Input) -> String {
    guard let pid = p.pid, pid > 0 else { return "{\"error\":\"no pid\"}" }
    guard let keys = p.keys else { return "{\"error\":\"missing keys\"}" }
    let SHIFT = CGEventFlags(rawValue: 0x00020000)
    for entry in keys {
        let code = UInt16(entry.code); let flags: CGEventFlags = (entry.shift ?? false) ? SHIFT : []
        guard let dn = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { continue }
        dn.flags = flags; up.flags = flags
        dn.postToPid(pid); up.postToPid(pid)
    }
    return "{\"ok\":true,\"method\":\"per-pid\"}"
}

// MARK: - Dispatch

guard let line = readLine(), let data = line.data(using: .utf8),
      let input = try? JSONDecoder().decode(Input.self, from: data)
else { out("{\"error\":\"invalid JSON\"}"); exit(1) }

switch input.command {
case "click": out(doClick(input))
case "doubleClick": out(doDoubleClick(input))
case "move": out(doMove(input))
case "drag": out(doDrag(input))
case "scroll": out(doScroll(input))
case "pressKey": out(doPressKey(input))
case "typeBatch": out(doTypeBatch(input))
case "ping": out(skylightMouseAvailable ? "{\"ok\":true,\"skylight\":true}" : "{\"ok\":true,\"skylight\":false}")
default: out("{\"error\":\"unknown\"}")
}
