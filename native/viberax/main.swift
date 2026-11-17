// viberax — macOS Accessibility (AX) primitives for driving Viber Desktop.
//
// Viber is a Qt Quick app. Its AX tree exposes stable QML object paths through
// AXIdentifier, e.g.
//   ...ApplicationWindowContentControl.SearchItem_QMLTYPE_299_QML_1933.TextFieldItem_QMLTYPE_301  (chat search)
//   ...SplitView_QMLTYPE_180.StackView_QMLTYPE_604.QQuickTextEdit_QML_765                         (composer)
//   ...SplitView_QMLTYPE_180.StackView_QMLTYPE_604.SendToolbarButton                             (send button)
//   ...StackView_QMLTYPE_604.FeedDelegate_QMLTYPE_282.TextEditItem_QMLTYPE_439_QML_553           (visible messages)
// The chat list rows and the conversation header title are NOT exposed.
//
// Every command prints one JSON object to stdout. Nothing here decides *what* to send:
// the MCP server orchestrates, verifies and asks the human first.
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Vision

let viberBundleID = "com.viber.osx"

// MARK: - output

func out(_ obj: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit((obj["ok"] as? Bool) == false ? 1 : 0)
}

func fail(_ msg: String, _ extra: [String: Any] = [:]) -> Never {
    var o = extra
    o["ok"] = false
    o["error"] = msg
    out(o)
}

// MARK: - AX helpers

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func frame(_ el: AXUIElement) -> CGRect? {
    var p = CGPoint.zero, s = CGSize.zero
    guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute) else { return nil }
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
}

func settable(_ el: AXUIElement, _ name: String) -> Bool {
    var b: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(el, name as CFString, &b) == .success && b.boolValue
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

struct Node {
    let el: AXUIElement
    let role: String
    let id: String
    let frame: CGRect
}

func viberApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: viberBundleID).first
}

func appElement() -> AXUIElement {
    guard AXIsProcessTrusted() else {
        fail("Accessibility permission missing. Grant it to the app that runs Claude Code (Terminal, iTerm, IDE…) in System Settings → Privacy & Security → Accessibility.", ["code": "not_trusted"])
    }
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 3.0)
    return el
}

/// Main Viber window = the AXStandardWindow that contains the conversation StackView.
func mainWindow(_ app: AXUIElement) -> AXUIElement? {
    let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    return wins.first { str($0, kAXSubroleAttribute) == "AXStandardWindow" } ?? wins.first
}

func collect(_ root: AXUIElement, maxNodes: Int = 5000) -> [Node] {
    var result: [Node] = []
    var stack: [AXUIElement] = [root]
    while let el = stack.popLast(), result.count < maxNodes {
        let role = str(el, kAXRoleAttribute) ?? ""
        let id = str(el, "AXIdentifier") ?? ""
        result.append(Node(el: el, role: role, id: id, frame: frame(el) ?? .zero))
        stack.append(contentsOf: children(el).reversed())
    }
    return result
}

func lastComponent(_ id: String) -> String { id.split(separator: ".").last.map(String.init) ?? id }

func findComposer(_ nodes: [Node]) -> Node? {
    nodes.first {
        $0.role == "AXTextField" && $0.id.contains("StackView_QMLTYPE") && !$0.id.contains("FeedDelegate")
            && !$0.id.contains("AIPanel") && lastComponent($0.id).hasPrefix("QQuickTextEdit")
    }
}

func findSendButton(_ nodes: [Node]) -> Node? {
    nodes.first { $0.role == "AXButton" && lastComponent($0.id) == "SendToolbarButton" }
}

func findSearchField(_ nodes: [Node]) -> Node? {
    nodes.first { $0.role == "AXTextField" && $0.id.contains("SearchItem_QMLTYPE") && $0.id.contains("TextFieldItem") }
}

func feedNodes(_ nodes: [Node]) -> [Node] {
    nodes.filter { $0.role == "AXTextField" && $0.id.contains("StackView_QMLTYPE") && $0.id.contains("FeedDelegate") }
        .sorted { $0.frame.minY < $1.frame.minY }
}

func describe(_ n: Node?) -> Any {
    guard let n else { return NSNull() }
    return ["id": n.id, "frame": [n.frame.minX, n.frame.minY, n.frame.width, n.frame.height],
            "valueSettable": settable(n.el, kAXValueAttribute), "focusSettable": settable(n.el, kAXFocusedAttribute),
            "focused": (attr(n.el, kAXFocusedAttribute) as? Bool) ?? false] as [String: Any]
}

/// Spin the run loop until `cond` holds or `seconds` elapse (NSWorkspace state updates need the run loop).
@discardableResult
func waitUntil(_ seconds: Double, _ cond: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if cond() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return cond()
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return }
    down.flags = flags
    up.flags = flags
    down.postToPid(pid)
    usleep(40_000)
    up.postToPid(pid)
}

// MARK: - window capture + OCR (search-result rows are not exposed via AX)

struct WinInfo {
    let id: CGWindowID
    let bounds: CGRect  // screen points, top-left origin
}

/// Viber's main window as seen by the window server (largest layer-0 on-screen window).
func viberWindowInfo(pid: pid_t) -> WinInfo? {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var best: WinInfo?
    for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let b = w[kCGWindowBounds as String] as? [String: Any],
              let r = CGRect(dictionaryRepresentation: b as CFDictionary),
              let n = w[kCGWindowNumber as String] as? CGWindowID else { continue }
        if best == nil || r.width * r.height > best!.bounds.width * best!.bounds.height { best = WinInfo(id: n, bounds: r) }
    }
    return best
}

/// Owner PID of the frontmost normal window containing `p` (front-to-back order).
func topmostOwner(at p: CGPoint) -> pid_t? {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for w in list {
        guard let b = w[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary),
              let layer = w[kCGWindowLayer as String] as? Int, layer < 1000, r.contains(p) else { continue }
        if layer == 0 || (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.1 { return w[kCGWindowOwnerPID as String] as? pid_t }
    }
    return nil
}

func captureWindow(_ wid: CGWindowID) -> CGImage? {
    let path = NSTemporaryDirectory() + "viberax-\(getpid()).png"
    defer { try? FileManager.default.removeItem(atPath: path) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-l", String(wid), path]
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    // Read the bytes into memory first: CGImageSource decodes lazily, and the file is
    // deleted when this function returns.
    guard p.terminationStatus == 0, let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
}

/// Lowercased letters/digits only (any script), single-spaced — for fuzzy title matching.
func normName(_ s: String) -> String {
    let folded = s.precomposedStringWithCompatibilityMapping.lowercased()
    let kept = folded.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
    return String(kept).split(separator: " ").joined(separator: " ")
}

func similarity(_ a: String, _ b: String) -> Double {
    if a.isEmpty || b.isEmpty { return 0 }
    if a == b { return 1 }
    let x = Array(a), y = Array(b)
    var prev = Array(0...y.count), cur = [Int](repeating: 0, count: y.count + 1)
    for i in 1...x.count {
        cur[0] = i
        for j in 1...y.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1)) }
        swap(&prev, &cur)
    }
    return 1 - Double(prev[y.count]) / Double(max(x.count, y.count))
}

func titleScore(ocr: String, name: String) -> Double {
    let o = normName(ocr), n = normName(name)
    if o.isEmpty || n.isEmpty { return 0 }
    if o == n { return 1 }
    var s = similarity(o, n)
    // Long names get truncated with "…" in the list: accept a solid prefix.
    if o.count >= 6, n.hasPrefix(o) { s = max(s, 0.85 * Double(o.count) / Double(n.count) + 0.15) }
    return s
}

/// Same normalisation as src/match.ts#norm: drop invisible/bidi characters, unify line
/// separators, NFKC, collapse whitespace. (Scalar ranges, so no invisible chars in source.)
func normText(_ s: String) -> String {
    var scalars = String.UnicodeScalarView()
    for u in s.unicodeScalars {
        let v = u.value
        if v == 0xAD || (0x200B...0x200F).contains(v) || (0x202A...0x202E).contains(v) || (0x2060...0x2064).contains(v)
            || (0x2066...0x2069).contains(v) || v == 0xFEFF { continue }
        scalars.append((v == 0x2028 || v == 0x2029 || v == 0x0D) ? "\n" : u)
    }
    return String(scalars).precomposedStringWithCompatibilityMapping
        .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// OCR lines inside `region` (screen points) of the given window capture.
func ocrLines(_ img: CGImage, window: CGRect, region: CGRect) -> [String] {
    let scale = Double(img.width) / Double(window.width)
    let px = CGRect(x: (region.minX - window.minX) * scale, y: (region.minY - window.minY) * scale,
                    width: region.width * scale, height: region.height * scale).integral
    guard let crop = img.cropping(to: px) else { return [] }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: crop, options: [:]).perform([req])
    return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}

func clickAt(_ p: CGPoint) {
    let original = CGEvent(source: nil)?.location ?? p
    let src = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(type == .leftMouseDown ? 60_000 : 30_000)
    }
    usleep(100_000)
    CGWarpMouseCursorPosition(original)
}

// MARK: - commands

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else {
    fail("usage: viberax status|feed|settable")
}

switch cmd {
case "request-permissions":
    // Show macOS's own prompts; they name the *responsible* app (Terminal, IntelliJ, Claude…)
    // that needs the permission. Neither call grants anything by itself.
    let ax = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    let screen = CGPreflightScreenCaptureAccess() ? true : CGRequestScreenCaptureAccess()
    out(["ok": true, "trusted": ax, "screenCapture": screen])

case "status":
    let trusted = AXIsProcessTrusted()
    let app = viberApp()
    var o: [String: Any] = ["ok": true, "trusted": trusted, "running": app != nil,
                            "frontmost": app?.isActive ?? false,
                            "screenCapture": CGPreflightScreenCaptureAccess()]
    if trusted, app != nil, let win = mainWindow(appElement()) {
        let nodes = collect(win)
        o["window"] = true
        o["composer"] = findComposer(nodes) != nil
        o["sendButton"] = findSendButton(nodes) != nil
        o["searchField"] = findSearchField(nodes) != nil
        o["visibleMessages"] = feedNodes(nodes).count
    } else {
        o["window"] = false
    }
    out(o)

case "settable":
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let nodes = collect(win)
    out(["ok": true, "composer": describe(findComposer(nodes)), "search": describe(findSearchField(nodes)),
         "send": describe(findSendButton(nodes))])

case "focused":
    // Which element has keyboard focus (role + QML id + value length; no content).
    let axApp = appElement()
    guard let f = attr(axApp, kAXFocusedUIElementAttribute) else { out(["ok": true, "focused": NSNull()]) }
    let el = f as! AXUIElement
    out(["ok": true, "role": str(el, kAXRoleAttribute) ?? "", "id": lastComponent(str(el, "AXIdentifier") ?? ""),
         "valueLength": (str(el, kAXValueAttribute) ?? "").count])

case "feed":
    // Visible message texts in the open conversation, top to bottom.
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let texts = feedNodes(collect(win)).compactMap { str($0.el, kAXValueAttribute) }
    out(["ok": true, "messages": texts])

case "activate":
    // Bring Viber to the front; report the previously frontmost app so it can be restored.
    let prev = NSWorkspace.shared.frontmostApplication
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    let axApp = appElement()
    if let win = mainWindow(axApp) {
        AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    }
    AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    app.activate()
    let ok = waitUntil(2.5) { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == viberBundleID }
    out(["ok": ok, "previousBundle": prev?.bundleIdentifier ?? "", "previousPid": Int(prev?.processIdentifier ?? 0)])

case "frontmost":
    let f = NSWorkspace.shared.frontmostApplication
    out(["ok": true, "pid": Int(f?.processIdentifier ?? 0), "bundle": f?.bundleIdentifier ?? ""])

case "restore":
    // restore <pid>: give focus back to the app that was frontmost before.
    guard args.count >= 2, let pid = pid_t(args[1]), pid > 0, let app = NSRunningApplication(processIdentifier: pid) else {
        out(["ok": true, "skipped": true])
    }
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    app.activate()
    out(["ok": waitUntil(1.5) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }])

case "focus":
    guard args.count >= 2 else { fail("usage: focus search|composer") }
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let nodes = collect(win)
    guard let target = args[1] == "search" ? findSearchField(nodes) : findComposer(nodes) else { fail("target not found") }
    AXUIElementSetAttributeValue(target.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    out(["ok": waitUntil(1.0) { (attr(target.el, kAXFocusedAttribute) as? Bool) == true }])

case "key":
    // key return|escape|down|up|delete|cmd-a|cmd-v — posted ONLY to Viber's pid, and only
    // while Viber is frontmost, so keystrokes can never land in another app.
    guard args.count >= 2 else { fail("usage: key <name>") }
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == viberBundleID else {
        fail("Viber is not frontmost; refusing to send keystrokes", ["code": "not_frontmost"])
    }
    let keys: [String: (CGKeyCode, CGEventFlags)] = [
        "return": (CGKeyCode(kVK_Return), []), "escape": (CGKeyCode(kVK_Escape), []),
        "down": (CGKeyCode(kVK_DownArrow), []), "up": (CGKeyCode(kVK_UpArrow), []),
        "delete": (CGKeyCode(kVK_Delete), []), "cmd-a": (CGKeyCode(kVK_ANSI_A), .maskCommand),
        "cmd-v": (CGKeyCode(kVK_ANSI_V), .maskCommand),
    ]
    guard let (code, flags) = keys[args[1]] else { fail("unknown key \(args[1])") }
    postKey(code, flags: flags, pid: app.processIdentifier)
    out(["ok": true])

case "locate":
    // locate (chat name on stdin): OCR the left panel below the search field and return the
    // screen point of the line that best matches the name (search results aren't in the AX tree).
    let name = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { fail("no name on stdin") }
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let nodes = collect(win)
    guard let search = findSearchField(nodes) else { fail("search field not found") }
    guard let wi = viberWindowInfo(pid: app.processIdentifier), let img = captureWindow(wi.id) else {
        fail("could not capture the Viber window (Screen Recording permission?)", ["code": "capture_failed"])
    }
    let scale = Double(img.width) / Double(wi.bounds.width)
    // Left panel: from the window's left edge to where the conversation view starts.
    let convoMinX = nodes.first { $0.id.hasSuffix("StackView_QMLTYPE_604") || lastComponent($0.id).hasPrefix("StackView_QMLTYPE") }?.frame.minX
        ?? (search.frame.maxX + 60)
    let panel = CGRect(x: wi.bounds.minX, y: search.frame.maxY + 6, width: max(200, convoMinX - wi.bounds.minX),
                       height: wi.bounds.maxY - search.frame.maxY - 6)
    let pixelRect = CGRect(x: (panel.minX - wi.bounds.minX) * scale, y: (panel.minY - wi.bounds.minY) * scale,
                           width: panel.width * scale, height: panel.height * scale).integral
    guard let crop = img.cropping(to: pixelRect) else { fail("crop failed") }
    if let dbg = ProcessInfo.processInfo.environment["VIBERAX_DEBUG_DIR"] {
        for (im, file) in [(img, "capture.png"), (crop, "crop.png")] {
            try? NSBitmapImageRep(cgImage: im).representation(using: .png, properties: [:])?
                .write(to: URL(fileURLWithPath: dbg).appendingPathComponent(file))
        }
        FileHandle.standardError.write(Data("img \(img.width)x\(img.height) win \(wi.bounds) panel \(panel) px \(pixelRect)\n".utf8))
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["en-US", "ru-RU", "uk-UA"]
    try? VNImageRequestHandler(cgImage: crop, options: [:]).perform([req])
    var cands: [(text: String, score: Double, pt: CGPoint)] = []
    for obs in req.results ?? [] {
        guard let top = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox  // normalized, origin bottom-left
        let cx = panel.minX + bb.midX * panel.width
        let cy = panel.minY + (1 - bb.midY) * panel.height
        cands.append((top.string, titleScore(ocr: top.string, name: name), CGPoint(x: cx, y: cy)))
    }
    // Best score wins; ties go to the topmost line (titles sit above previews).
    let best = cands.filter { $0.score >= 0.75 }.sorted { $0.score != $1.score ? $0.score > $1.score : $0.pt.y < $1.pt.y }.first
    let lines = cands.count
    guard let b = best else { fail("chat not found in search results", ["code": "not_found", "ocrLines": lines]) }
    out(["ok": true, "x": Double(b.pt.x), "y": Double(b.pt.y), "score": b.score, "matched": b.text, "ocrLines": lines])

case "header":
    // OCR the open conversation's header (chat title is drawn there but not exposed via AX).
    // Prints the recognised lines; with a name on stdin also scores the best match.
    let want = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let nodes = collect(win)
    guard let stack = nodes.first(where: { lastComponent($0.id).hasPrefix("StackView_QMLTYPE") && $0.role == "AXGroup" }) else {
        fail("conversation view not found", ["code": "no_conversation"])
    }
    // Header = top strip of the conversation view, left of the header buttons (call/info/search…).
    let headerButtons = nodes.filter { $0.role == "AXButton" && $0.id.contains(lastComponent(stack.id)) && $0.frame.minY < stack.frame.minY + 60 }
    let right = headerButtons.map { $0.frame.minX }.min() ?? (stack.frame.maxX - 200)
    let region = CGRect(x: stack.frame.minX, y: stack.frame.minY, width: max(100, right - stack.frame.minX - 8), height: 64)
    guard let wi = viberWindowInfo(pid: app.processIdentifier), let img = captureWindow(wi.id) else {
        fail("could not capture the Viber window", ["code": "capture_failed"])
    }
    let scale = Double(img.width) / Double(wi.bounds.width)
    let px = CGRect(x: (region.minX - wi.bounds.minX) * scale, y: (region.minY - wi.bounds.minY) * scale,
                    width: region.width * scale, height: region.height * scale).integral
    guard let crop = img.cropping(to: px) else { fail("crop failed") }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["en-US", "ru-RU", "uk-UA"]
    try? VNImageRequestHandler(cgImage: crop, options: [:]).perform([req])
    let lines = (req.results ?? []).sorted { $0.boundingBox.midY > $1.boundingBox.midY }.compactMap { $0.topCandidates(1).first?.string }
    var o: [String: Any] = ["ok": true, "lines": lines]
    if !want.isEmpty { o["score"] = lines.map { titleScore(ocr: $0, name: want) }.max() ?? 0 }
    out(o)

case "feed-items":
    // Visible message texts with their screen frames (top to bottom) — to locate one message.
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let items: [[String: Any]] = feedNodes(collect(win)).map {
        ["value": str($0.el, kAXValueAttribute) ?? "", "frame": [$0.frame.minX, $0.frame.minY, $0.frame.width, $0.frame.height]]
    }
    out(["ok": true, "items": items])

case "heart":
    // heart (JSON on stdin) — click the ♡ (like toggle) of ONE incoming message in the open chat.
    //   {"mode":"text","text":"…","rank":0,"group":false}      rank = how many newer visible
    //   {"mode":"media","rank":0,"timeLabel":"14:05"}            messages share the same text /
    //   optional "dryRun": true                                  are photos/videos
    // The ♡ isn't in the AX tree; its position is derived from fresh AX geometry right before
    // the click, and the command aborts if the feed moved in between (new messages arriving).
    let req = (try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile())) as? [String: Any] ?? [:]
    let mode = req["mode"] as? String ?? ""
    let rank = max(0, req["rank"] as? Int ?? 0)
    let isGroup = req["group"] as? Bool ?? false
    let dryRun = req["dryRun"] as? Bool ?? false
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    let pid = app.processIdentifier
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == viberBundleID else {
        fail("Viber is not frontmost; refusing to click", ["code": "not_frontmost"])
    }
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    func stackOf(_ nodes: [Node]) -> Node? { nodes.first { lastComponent($0.id).hasPrefix("StackView_QMLTYPE") && $0.role == "AXGroup" } }
    var nodes = collect(win)
    guard let stack = stackOf(nodes) else { fail("conversation view not found", ["code": "no_conversation"]) }
    var heart = CGPoint.zero
    var anchor: [String: Any] = [:]

    if mode == "text" {
        let want = normText(req["text"] as? String ?? "")
        guard !want.isEmpty else { fail("no text given") }
        func matches(_ ns: [Node]) -> [Node] { feedNodes(ns).filter { normText(str($0.el, kAXValueAttribute) ?? "") == want } }
        let first = matches(nodes)
        guard first.count > rank else { fail("the message isn't visible in the open chat", ["code": "not_visible", "visibleMatches": first.count]) }
        let item = first[first.count - 1 - rank]
        let hoverPt = CGPoint(x: item.frame.minX + min(item.frame.width, 200) / 2, y: item.frame.midY)
        guard topmostOwner(at: hoverPt) == pid else { fail("another window covers the message", ["code": "occluded"]) }
        let src = CGEventSource(stateID: .hidSystemState)
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: hoverPt, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(450_000)  // hover reveals the action row (reply button) of this bubble
        nodes = collect(win)
        let again = matches(nodes)
        guard again.count == first.count, abs(again[again.count - 1 - rank].frame.minY - item.frame.minY) < 1.5 else {
            fail("the chat moved (new messages?) — not clicking", ["code": "moved"])
        }
        let it = again[again.count - 1 - rank]
        let replies = nodes.filter {
            $0.role == "AXButton" && $0.id.contains("FeedDelegate") && lastComponent($0.id).hasPrefix("IconButton_QMLTYPE")
                && $0.frame.minY >= it.frame.maxY - 2 && $0.frame.minY <= it.frame.maxY + 45 && $0.frame.minX >= it.frame.minX
        }
        guard let reply = replies.min(by: { $0.frame.minY < $1.frame.minY }) else {
            fail("couldn't find this message's action row (is it an incoming message?)", ["code": "no_anchor"])
        }
        // Calibrated on Viber 29.5: ♡ sits 29 pt right of the reply icon, centred on the bubble
        // (bubble = text top − 7.5 [− 21 for the sender-name line in groups] … reply bottom + 6.5).
        let top = it.frame.minY - 7.5 - (isGroup ? 21 : 0)
        heart = CGPoint(x: reply.frame.maxX + 29, y: (top + reply.frame.maxY + 6.5) / 2)
        anchor = ["text": [it.frame.minX, it.frame.minY, it.frame.width, it.frame.height], "reply": [reply.frame.minX, reply.frame.minY]]
    } else if mode == "media" {
        func shares(_ ns: [Node]) -> [Node] {
            ns.filter { $0.role == "AXButton" && $0.id.contains("FeedDelegate") && lastComponent($0.id).hasPrefix("RoundIconButton_QMLTYPE") }
                .sorted { $0.frame.minY < $1.frame.minY }
        }
        let s = shares(nodes)
        guard s.count > rank else { fail("the photo/video isn't visible in the open chat", ["code": "not_visible", "visibleMedia": s.count]) }
        let share = s[s.count - 1 - rank]
        guard share.frame.midX < stack.frame.midX else { fail("that media message isn't an incoming one", ["code": "unsupported"]) }
        // Identity check: the bubble's time label (e.g. "14:05") must be visible left of the share button.
        if let label = req["timeLabel"] as? String, !label.isEmpty {
            guard let wi = viberWindowInfo(pid: pid), let img = captureWindow(wi.id) else {
                fail("could not capture the Viber window", ["code": "capture_failed"])
            }
            let region = CGRect(x: max(stack.frame.minX, share.frame.minX - 420), y: max(stack.frame.minY, share.frame.midY - 360),
                                width: min(415, share.frame.minX - max(stack.frame.minX, share.frame.minX - 420)), height: 720)
            let lines = ocrLines(img, window: wi.bounds, region: region).map { $0.trimmingCharacters(in: .whitespaces) }
            guard lines.contains(label) else {
                fail("couldn't confirm the photo's time label \(label) on screen", ["code": "unverified", "ocrLines": lines.count])
            }
        }
        // Calibrated on Viber 29.5: ♡ is the round button 34 pt left of the share button.
        heart = CGPoint(x: share.frame.midX - 34, y: share.frame.midY)
        usleep(150_000)
        let s2 = shares(collect(win))
        guard s2.count == s.count, abs(s2[s2.count - 1 - rank].frame.minY - share.frame.minY) < 1.5 else {
            fail("the chat moved (new messages?) — not clicking", ["code": "moved"])
        }
        anchor = ["share": [share.frame.minX, share.frame.minY, share.frame.width, share.frame.height]]
    } else {
        fail("mode must be text or media")
    }

    guard stack.frame.contains(heart) else { fail("computed ♡ position is outside the conversation", ["code": "outside"]) }
    guard topmostOwner(at: heart) == pid else { fail("another window covers the ♡", ["code": "occluded"]) }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == viberBundleID else {
        fail("Viber lost focus; not clicking", ["code": "not_frontmost"])
    }
    if !dryRun { clickAt(heart) }
    out(["ok": true, "x": Double(heart.x), "y": Double(heart.y), "dryRun": dryRun, "anchor": anchor])

case "hover", "right-click":
    // hover|right-click <x> <y>: same guards as click (Viber frontmost + topmost at that point).
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else { fail("usage: \(cmd) x y") }
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == viberBundleID else {
        fail("Viber is not frontmost; refusing", ["code": "not_frontmost"])
    }
    let p = CGPoint(x: x, y: y)
    guard topmostOwner(at: p) == app.processIdentifier else { fail("another window covers that point; refusing", ["code": "occluded"]) }
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    if cmd == "right-click" {
        usleep(80_000)
        CGEvent(mouseEventSource: src, mouseType: .rightMouseDown, mouseCursorPosition: p, mouseButton: .right)?.post(tap: .cghidEventTap)
        usleep(60_000)
        CGEvent(mouseEventSource: src, mouseType: .rightMouseUp, mouseCursorPosition: p, mouseButton: .right)?.post(tap: .cghidEventTap)
    }
    out(["ok": true])

case "click":
    // click <x> <y> (screen points). Only when Viber is frontmost AND Viber owns the topmost
    // window at that point. The cursor is put back where it was.
    guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else { fail("usage: click x y") }
    guard let app = viberApp() else { fail("Viber is not running", ["code": "not_running"]) }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == viberBundleID else {
        fail("Viber is not frontmost; refusing to click", ["code": "not_frontmost"])
    }
    let p = CGPoint(x: x, y: y)
    guard topmostOwner(at: p) == app.processIdentifier else {
        fail("another window covers that point; refusing to click", ["code": "occluded"])
    }
    let original = CGEvent(source: nil)?.location ?? p
    let src = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(type == .leftMouseDown ? 60_000 : 30_000)
    }
    usleep(100_000)
    CGWarpMouseCursorPosition(original)
    out(["ok": true])

case "get-value":
    // get-value search|composer → current text (used to verify before pressing Enter).
    guard args.count >= 2 else { fail("usage: get-value search|composer") }
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let nodes = collect(win)
    guard let target = args[1] == "search" ? findSearchField(nodes) : findComposer(nodes) else { fail("target not found", ["code": "no_target"]) }
    out(["ok": true, "value": str(target.el, kAXValueAttribute) ?? "",
         "focused": (attr(target.el, kAXFocusedAttribute) as? Bool) ?? false])

case "press-send":
    // AXPress on the composer's Send button (fallback when Return inserts a newline).
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    guard let btn = findSendButton(collect(win)) else { fail("send button not found", ["code": "no_target"]) }
    let err = AXUIElementPerformAction(btn.el, kAXPressAction as CFString)
    out(["ok": err == .success, "axError": err.rawValue])

case "set-value":
    // set-value search|composer  (text on stdin, so it never appears in argv / ps)
    guard args.count >= 2 else { fail("usage: set-value search|composer < text") }
    let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    guard let win = mainWindow(appElement()) else { fail("no Viber window") }
    let nodes = collect(win)
    guard let target = args[1] == "search" ? findSearchField(nodes) : findComposer(nodes) else { fail("target not found") }
    let err = AXUIElementSetAttributeValue(target.el, kAXValueAttribute as CFString, text as CFString)
    out(["ok": err == .success, "axError": err.rawValue, "valueNow": (str(target.el, kAXValueAttribute) ?? "").count])

default:
    fail("unknown command \(cmd)")
}
