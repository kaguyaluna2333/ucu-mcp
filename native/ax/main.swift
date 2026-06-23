// ax-helper: native AX-tree traversal via CoreFoundation (no JXA bridge).
//
// Replaces the slow osascript -l JavaScript path in ax-tree.ts getWindowState /
// findElement. JXA pays a JS<->ObjC bridge hop PER attribute read (6-10 Mach
// IPCs per node, not batched) plus a ~100ms osascript spawn per call — the
// measured bottleneck (find_element depth:10 = 11.2s on ccSwitch). This helper
// calls AXUIElementCopyAttributeValue directly. Expected depth:10 ~11s -> ~1s.
//
// stdout JSON shapes are IDENTICAL to ax-tree.ts:209 / :417 — TS swaps the
// osascript call for a helper spawn, zero parse changes, JXA fallback preserved.
//
// Build:
//   swiftc -O -o ax-helper main.swift -framework ApplicationServices -framework AppKit -framework Foundation
// ponytail: one-shot CLI mirroring native/{ocr,skylight,windowlist,sck}; no daemon.

import ApplicationServices
import AppKit
import Foundation

struct Bounds: Codable {
  var x: Double = 0; var y: Double = 0; var width: Double = 0; var height: Double = 0
  static let zero = Bounds()
}
struct WindowInfo: Codable {
  var id: String = ""; var title: String = ""; var processName: String = ""
  var pid: Int = 0; var bounds: Bounds = .zero; var isMinimized = false; var isOnScreen = true
}
struct TreeNode: Codable {
  var role = ""; var name = ""; var value = ""; var states: [String] = []
  var bounds: Bounds = .zero; var children: [TreeNode] = []
}
struct FocusedElement: Codable {
  var role = ""; var name = ""; var value = ""; var states: [String] = []; var bounds: Bounds?
}
struct GetWindowStateResult: Codable {
  var window: WindowInfo?; var focusedElement: FocusedElement?; var tree: TreeNode?; var error: String?
}
struct FindItem: Codable {
  var id: String; var role: String; var name: String
  var value: String?; var description: String?; var subrole: String?; var identifier: String?; var bounds: Bounds?
}
struct FindResult: Codable {
  var results: [FindItem]; var scannedCount: Int; var matchedCount: Int; var error: String?
}
struct AXInput: Decodable {
  var command: String; var pid: Int32?; var windowId: String?; var depth: Int?; var maxNodes: Int?
  var includeBounds: Bool?; var app: String?; var scanAllProcesses: Bool?
  var maxResults: Int?; var text: String?; var role: String?; var value: String?; var textMode: String?; var visibleOnly: Bool?
}

func emit<T: Encodable>(_ r: T) -> Never {
  // try? not try! — a NaN/Inf in bounds or an encoding failure must not crash the
  // helper (which would leave stdout empty and the TS layer unable to parse).
  let data = (try? JSONEncoder().encode(r)) ?? "{\"error\":\"json encode failed\"}".data(using: .utf8)!
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!); exit(0)
}
func emitError(_ msg: String, _ cmd: String) -> Never {
  if cmd == "findElement" { emit(FindResult(results: [], scannedCount: 0, matchedCount: 0, error: msg)) }
  emit(GetWindowStateResult(error: msg))
}

// MARK: AX readers (direct C API)
func axString(_ el: AXUIElement, _ attr: CFString) -> String {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr, &ref) == .success, let v = ref else { return "" }
  return axValueToString(v)
}
func axValueToString(_ v: CFTypeRef) -> String {
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  if let b = v as? Bool { return b ? "true" : "false" }
  if let arr = v as? [Any] { return arr.map { axValueToString($0 as CFTypeRef) }.joined(separator: ",") }
  return "\(v)"
}
func axChildren(_ el: AXUIElement) -> [AXUIElement] {
  var ref: CFTypeRef?
  if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ref) == .success, let a = ref as? [AXUIElement] { return a }
  if AXUIElementCopyAttributeValue(el, kAXVisibleChildrenAttribute as CFString, &ref) == .success, let a = ref as? [AXUIElement] { return a }
  return []
}
func axBounds(_ el: AXUIElement) -> Bounds {
  var b = Bounds()
  var ref: CFTypeRef?
  let axValueTypeID = AXValueGetTypeID()
  if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &ref) == .success,
     let v = ref, CFGetTypeID(v) == axValueTypeID {
    let av = v as! AXValue  // force-cast safe: CFGetTypeID confirmed AXValue above
    var p = CGPoint()
    if AXValueGetType(av) == .cgPoint && AXValueGetValue(av, .cgPoint, &p) { b.x = p.x; b.y = p.y }
  }
  if AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &ref) == .success,
     let v = ref, CFGetTypeID(v) == axValueTypeID {
    let av = v as! AXValue
    var s = CGSize()
    if AXValueGetType(av) == .cgSize && AXValueGetValue(av, .cgSize, &s) { b.width = s.width; b.height = s.height }
  }
  return b
}
func axFocused(_ el: AXUIElement) -> Bool {
  var ref: CFTypeRef?
  if AXUIElementCopyAttributeValue(el, kAXFocusedAttribute as CFString, &ref) == .success {
    if let n = ref as? NSNumber { return n.boolValue }; if let b = ref as? Bool { return b }
  }
  return false
}
func axIsVisible(_ el: AXUIElement) -> Bool {
  let b = axBounds(el); return b.width > 0 && b.height > 0 && b.x > -10000 && b.y > -10000
}
func matches(_ s: String, _ q: String, _ mode: String) -> Bool {
  switch mode {
  case "exact": return s == q
  case "regex": return (try? NSRegularExpression(pattern: q, options: .caseInsensitive))
    .flatMap { $0.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil ? true : nil } ?? false
  default: return s.range(of: q, options: .caseInsensitive) != nil
  }
}

// MARK: traversal (stateful)
final class AxWalker {
  let maxDepth: Int; let maxNodes: Int; let includeBounds: Bool
  var nodeCount = 0
  init(_ d: Int, _ n: Int, _ b: Bool) { maxDepth = d; maxNodes = n; includeBounds = b }

  // getWindowState DFS (name = description ?? title, mirrors ax-tree.ts:171-194)
  func extractTree(_ el: AXUIElement, _ depth: Int, _ focused: inout FocusedElement?) -> TreeNode {
    var node = TreeNode()
    node.role = axString(el, kAXRoleAttribute as CFString)
    let desc = axString(el, kAXDescriptionAttribute as CFString)
    let title = axString(el, kAXTitleAttribute as CFString)
    node.name = desc.isEmpty ? title : desc
    node.value = axString(el, kAXValueAttribute as CFString)
    node.states = axFocused(el) ? ["focused"] : []
    node.bounds = includeBounds ? axBounds(el) : .zero
    nodeCount += 1
    if focused == nil && node.states.contains("focused") {
      focused = FocusedElement(role: node.role, name: node.name, value: node.value, states: node.states, bounds: includeBounds ? node.bounds : nil)
    }
    if depth < maxDepth && nodeCount < maxNodes {
      for c in axChildren(el) {
        if nodeCount >= maxNodes { break }
        node.children.append(extractTree(c, depth + 1, &focused))
      }
    }
    return node
  }

  // findElement DFS
  func walk(_ el: AXUIElement, _ prefix: String, _ depth: Int,
            _ f: FindFilter, _ results: inout [FindItem], _ scanned: inout Int) {
    if nodeCount >= maxNodes || results.count >= f.maxResults { return }
    nodeCount += 1; scanned += 1
    let role = axString(el, kAXRoleAttribute as CFString)
    let title = axString(el, kAXTitleAttribute as CFString)
    let desc = axString(el, kAXDescriptionAttribute as CFString)
    let val = axString(el, kAXValueAttribute as CFString)
    let name = desc.isEmpty ? title : desc
    if (f.role == nil || role == f.role)
        && (f.value == nil || matches(val, f.value!, f.mode) || matches(name, f.value!, f.mode))
        && (f.text == nil || matches(name, f.text!, f.mode) || matches(val, f.text!, f.mode) || matches(desc, f.text!, f.mode))
        && (!f.visibleOnly || axIsVisible(el)) {
      var item = FindItem(id: prefix, role: role, name: name)
      if !val.isEmpty { item.value = val }
      if !desc.isEmpty { item.description = desc }
      let sub = axString(el, kAXSubroleAttribute as CFString); if !sub.isEmpty { item.subrole = sub }
      let ident = axString(el, kAXIdentifierAttribute as CFString); if !ident.isEmpty { item.identifier = ident }
      if includeBounds { item.bounds = axBounds(el) }
      results.append(item)
    }
    if depth < maxDepth {
      for (i, c) in axChildren(el).enumerated() {
        if nodeCount >= f.maxNodesCap || results.count >= f.maxResults { break }
        walk(c, "\(prefix)/\(i)", depth + 1, f, &results, &scanned)
      }
    }
  }
}

struct FindFilter {
  let text: String?; let role: String?; let value: String?; let mode: String
  let visibleOnly: Bool; let maxResults: Int; let maxNodesCap: Int
}

// MARK: read stdin + dispatch
guard let data = FileHandle.standardInput.readDataToEndOfFile() as Data?, !data.isEmpty,
      let input = try? JSONDecoder().decode(AXInput.self, from: data) else {
  emitError("invalid json", "getWindowState")
}
let maxDepth = min(input.depth ?? 3, 10)
let maxNodes = input.maxNodes ?? 50
let includeBounds = input.includeBounds ?? true

if input.command == "findElement" {
  let maxResults = input.maxResults ?? 50
  let filter = FindFilter(text: input.text, role: input.role, value: input.value,
                          mode: input.textMode ?? "contains", visibleOnly: input.visibleOnly ?? false,
                          maxResults: maxResults, maxNodesCap: maxNodes)
  // resolve target pids: explicit pid, app-name lookup (mirrors JXA
  // se.processes[name] via NSWorkspace localizedName/bundleIdentifier), or all
  // processes. TS layer passes pid when an activeTarget exists (focus_app); the
  // app-name path covers direct find_element({app}) without a prior focus.
  let pids: [Int32]
  if input.scanAllProcesses ?? false {
    pids = NSWorkspace.shared.runningApplications.compactMap { $0.processIdentifier }
  } else if let pid = input.pid {
    pids = [pid]
  } else if let appName = input.app, !appName.isEmpty {
    let apps = NSWorkspace.shared.runningApplications.filter {
      ($0.localizedName ?? "") == appName || $0.bundleIdentifier == appName
    }
    if apps.isEmpty { emit(FindResult(results: [], scannedCount: 0, matchedCount: 0, error: "app not found: \(appName)")) }
    pids = apps.map { $0.processIdentifier }
  } else {
    emit(FindResult(results: [], scannedCount: 0, matchedCount: 0, error: "missing pid/app"))
  }
  let appPrefix = (input.app ?? input.windowId?.split(separator: "/").first.map(String.init)).map { $0 + "/" } ?? ""
  let walker = AxWalker(maxDepth, maxNodes, includeBounds)
  var results: [FindItem] = []; var scanned = 0
  outer: for pid in pids {
    let appEl = AXUIElementCreateApplication(pid)
    var wref: CFTypeRef?; var windowsArr: [AXUIElement] = []
    if AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wref) == .success, let a = wref as? [AXUIElement] { windowsArr = a }
    if windowsArr.isEmpty { windowsArr = axChildren(appEl) }
    for (i, win) in windowsArr.enumerated() {
      walker.walk(win, "\(appPrefix)win\(i)", 0, filter, &results, &scanned)
      if results.count >= maxResults { break outer }
    }
  }
  emit(FindResult(results: results, scannedCount: scanned, matchedCount: results.count, error: nil))
} else {
  // getWindowState
  guard let pid = input.pid else { emitError("missing pid", input.command) }
  let appEl = AXUIElementCreateApplication(pid)
  let walker = AxWalker(maxDepth, maxNodes, includeBounds)
  var winInfo = WindowInfo()
  winInfo.pid = Int(pid); winInfo.id = input.windowId ?? ""
  if let pn = NSRunningApplication(processIdentifier: pid)?.localizedName { winInfo.processName = pn }
  var windowsArr: [AXUIElement] = []
  var wref: CFTypeRef?
  if AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wref) == .success, let a = wref as? [AXUIElement] { windowsArr = a }
  if windowsArr.isEmpty { windowsArr = axChildren(appEl) }
  if windowsArr.isEmpty {
    // stale pid or app with no AX windows — error so the TS layer falls back to
    // JXA (which throws WindowNotFoundError/TargetStaleError) instead of getting
    // a tree-less "success" window.
    emit(GetWindowStateResult(window: nil, focusedElement: nil, tree: nil, error: "no ax windows for pid \(pid)"))
  }
  let winIdx = Int(input.windowId?.split(separator: "/").last.flatMap { Int($0.dropFirst(3)) } ?? 0)
  var focused: FocusedElement?
  // focused element is detected during extractTree (node.states "focused"),
  // mirroring ax-tree.ts:171-194 — no separate app-level fetch needed.
  var tree: TreeNode?
  if winIdx < windowsArr.count {
    let win = windowsArr[winIdx]
    winInfo.title = axString(win, kAXTitleAttribute as CFString)
    winInfo.bounds = axBounds(win)
    tree = walker.extractTree(win, 0, &focused)
  }
  emit(GetWindowStateResult(window: winInfo, focusedElement: focused, tree: tree, error: nil))
}
