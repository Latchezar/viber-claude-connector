// ax-dump.swift — dump Viber Desktop's accessibility (AX) tree.
//
// usage: swiftc -O scripts/ax-dump.swift -o bin/ax-dump && bin/ax-dump [--depth N] [--max N] [--values] [--json]
//   --values  include text values/titles verbatim (default: redacted to their length,
//             because they contain chat names and message text)
// Requires the calling app (Terminal/iTerm/IDE) to have Accessibility permission.
import AppKit
import ApplicationServices

var maxDepth = 40
var maxNodes = 4000
var showValues = false
var asJSON = false
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    switch a {
    case "--depth": maxDepth = Int(args.next() ?? "") ?? maxDepth
    case "--max": maxNodes = Int(args.next() ?? "") ?? maxNodes
    case "--values": showValues = true
    case "--json": asJSON = true
    default: break
    }
}

guard AXIsProcessTrusted() else {
    FileHandle.standardError.write("Not trusted for Accessibility. Grant it to your terminal app in System Settings → Privacy & Security → Accessibility.\n".data(using: .utf8)!)
    exit(2)
}
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.viber.osx").first else {
    FileHandle.standardError.write("Viber is not running.\n".data(using: .utf8)!)
    exit(3)
}

let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(root, 3.0)

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func frame(_ el: AXUIElement) -> String? {
    var p = CGPoint.zero, s = CGSize.zero
    guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute) else { return nil }
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return "\(Int(p.x)),\(Int(p.y)) \(Int(s.width))x\(Int(s.height))"
}

func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    AXUIElementCopyActionNames(el, &names)
    return (names as? [String]) ?? []
}

func redact(_ s: String?) -> String? {
    guard let s else { return nil }
    if showValues { return s.count > 160 ? String(s.prefix(160)) + "…" : s }
    return "<\(s.count)ch>"
}

var count = 0
var roleCounts: [String: Int] = [:]
var jsonNodes: [[String: Any]] = []

func dump(_ el: AXUIElement, depth: Int, path: String) {
    guard count < maxNodes, depth <= maxDepth else { return }
    count += 1
    let role = str(el, kAXRoleAttribute) ?? "?"
    let sub = str(el, kAXSubroleAttribute)
    roleCounts[role, default: 0] += 1
    var fields: [String: Any] = ["path": path, "role": role]
    var line = String(repeating: "  ", count: depth) + role
    if let sub { line += "/\(sub)"; fields["subrole"] = sub }
    for (key, label) in [(kAXTitleAttribute, "title"), (kAXDescriptionAttribute, "desc"), (kAXValueAttribute, "value"),
                         (kAXHelpAttribute, "help"), ("AXPlaceholderValue", "placeholder")] {
        if let v = str(el, key) { line += " \(label)=\(redact(v)!.debugDescription)"; fields[label] = redact(v) }
    }
    if let ident = str(el, "AXIdentifier") { line += " id=\(ident)"; fields["id"] = ident }
    if let f = frame(el) { line += " [\(f)]"; fields["frame"] = f }
    if (attr(el, kAXFocusedAttribute) as? Bool) == true { line += " FOCUSED"; fields["focused"] = true }
    if (attr(el, kAXSelectedAttribute) as? Bool) == true { line += " SELECTED"; fields["selected"] = true }
    if (attr(el, kAXEnabledAttribute) as? Bool) == false { line += " disabled" }
    let acts = actions(el).filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
    if !acts.isEmpty { line += " actions=\(acts.joined(separator: ","))"; fields["actions"] = acts }
    let kids = (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    if !kids.isEmpty { line += " (\(kids.count))" }
    if asJSON { jsonNodes.append(fields) } else { print(line) }
    for (i, k) in kids.enumerated() { dump(k, depth: depth + 1, path: "\(path).\(i)") }
}

// Qt builds its accessibility tree lazily; touching the app element first helps.
_ = attr(root, kAXWindowsAttribute)
dump(root, depth: 0, path: "0")

if asJSON {
    let data = try! JSONSerialization.data(withJSONObject: ["nodes": jsonNodes, "count": count], options: [])
    FileHandle.standardOutput.write(data)
} else {
    print("\n# nodes: \(count)" + (count >= maxNodes ? " (limit reached)" : ""))
    print("# roles: " + roleCounts.sorted { $0.value > $1.value }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))
}
