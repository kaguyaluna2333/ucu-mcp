import CoreGraphics
import Foundation

// Simple flat params struct — avoids recursive enum decoding issues
struct Input: Decodable {
    let command: String
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

func out(_ json: String) { FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!); fflush(stdout) }
func post(_ event: CGEvent) { event.post(tap: CGEventTapLocation.cghidEventTap) }

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

func doClick(_ p: Input) -> String {
    let loc = CGPoint(x: p.x ?? 0, y: p.y ?? 0); let b = btn(p.button)
    guard let dn = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: loc, mouseButton: b),
          let up = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: loc, mouseButton: b)
    else { return "{\"error\":\"fail\"}" }
    post(dn); post(up); return "{\"ok\":true}"
}

func doDoubleClick(_ p: Input) -> String {
    let loc = CGPoint(x: p.x ?? 0, y: p.y ?? 0); let b = btn(p.button)
    guard let d1 = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: loc, mouseButton: b),
          let u1 = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: loc, mouseButton: b),
          let d2 = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: loc, mouseButton: b),
          let u2 = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: loc, mouseButton: b)
    else { return "{\"error\":\"fail\"}" }
    d1.setIntegerValueField(.mouseEventClickState, value: 1); u1.setIntegerValueField(.mouseEventClickState, value: 1)
    d2.setIntegerValueField(.mouseEventClickState, value: 2); u2.setIntegerValueField(.mouseEventClickState, value: 2)
    post(d1); post(u1); post(d2); post(u2); return "{\"ok\":true}"
}

func doMove(_ p: Input) -> String {
    let loc = CGPoint(x: p.x ?? 0, y: p.y ?? 0)
    guard let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: loc, mouseButton: .left)
    else { return "{\"error\":\"fail\"}" }
    post(ev); return "{\"ok\":true}"
}

func doDrag(_ p: Input) -> String {
    let from = CGPoint(x: p.fromX ?? 0, y: p.fromY ?? 0)
    let to = CGPoint(x: p.toX ?? 0, y: p.toY ?? 0)
    let ms = p.durationMs ?? 300; let b = btn(p.button)
    let steps = max(2, min(60, Int(ceil(Double(ms) / 16.0))))
    let delay = max(0, (ms * 1000) / steps)
    guard let dn = CGEvent(mouseEventSource: nil, mouseType: downT(b), mouseCursorPosition: from, mouseButton: b)
    else { return "{\"error\":\"fail\"}" }
    post(dn)
    for n in 1...steps {
        let t = Double(n) / Double(steps)
        let pt = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        if let ev = CGEvent(mouseEventSource: nil, mouseType: dragT(b), mouseCursorPosition: pt, mouseButton: b) { post(ev) }
        if delay > 0 && n < steps { usleep(UInt32(delay)) }
    }
    if let up = CGEvent(mouseEventSource: nil, mouseType: upT(b), mouseCursorPosition: to, mouseButton: b) { post(up) }
    return "{\"ok\":true}"
}

func doScroll(_ p: Input) -> String {
    let dy = Int32(-(p.deltaY ?? 0)); let dx = Int32(p.deltaX ?? 0)
    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    else { return "{\"error\":\"fail\"}" }
    post(ev); return "{\"ok\":true}"
}

func doPressKey(_ p: Input) -> String {
    let code = UInt16(p.keyCode ?? 0); let flags = CGEventFlags(rawValue: UInt64(p.flags ?? 0))
    guard let dn = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { return "{\"error\":\"fail\"}" }
    dn.flags = flags; up.flags = flags; post(dn); post(up); return "{\"ok\":true}"
}

func doTypeBatch(_ p: Input) -> String {
    guard let keys = p.keys else { return "{\"error\":\"missing keys\"}" }
    let SHIFT = CGEventFlags(rawValue: 0x00020000)
    for entry in keys {
        let code = UInt16(entry.code); let flags: CGEventFlags = (entry.shift ?? false) ? SHIFT : []
        guard let dn = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { continue }
        dn.flags = flags; up.flags = flags; post(dn); post(up)
    }
    return "{\"ok\":true}"
}

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
case "ping": out("{\"ok\":true}")
default: out("{\"error\":\"unknown\"}")
}
