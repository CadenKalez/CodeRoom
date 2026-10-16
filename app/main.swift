// Code Room.app — a native window around the Code Room page.
//
// It starts the bundled server.py (read-only scanner) on a free local port, shows the
// page in a WebKit view, and adds what a browser tab can't: a native folder picker,
// opening folders dropped on the window or the Dock icon, and opening source files
// in your editor. Quitting the app stops the server.

import Cocoa
import WebKit

let appName = "Code Room"

/// WKWebView that accepts folders dragged onto the window.
final class DropWebView: WKWebView {
    var onFolderDrop: ((String) -> Void)?

    private func droppedFolder(_ info: NSDraggingInfo) -> String? {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        guard let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL] else { return nil }
        for url in urls {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue { return url.path }
        }
        return nil
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFolder(sender) != nil ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFolder(sender) != nil ? .copy : super.draggingUpdated(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let path = droppedFolder(sender) {
            onFolderDrop?(path)
            return true
        }
        return super.performDragOperation(sender)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: DropWebView!
    var server: Process?
    var serverURL: URL?
    var pageReady = false
    var pendingFolders: [String] = []
    var quitting = false
    var titleObservation: NSKeyValueObservation?
    var log: FileHandle?

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        openLog()
        buildMenu()
        buildWindow()
        startServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { openFolder(url.path) }  // folders dropped on the Dock icon or "Open With"
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.terminate()
    }

    // MARK: window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "codeRoom")
        config.mediaTypesRequiringUserActionForPlayback = []   // the ambience may start without a click
        webView = DropWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")  // no white flash before the page paints
        webView.onFolderDrop = { [weak self] path in self?.openFolder(path) }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = appName
        window.appearance = NSAppearance(named: .darkAqua)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.016, green: 0.008, blue: 0.047, alpha: 1)
        window.minSize = NSSize(width: 760, height: 520)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("CodeRoomMainWindow")
        window.makeKeyAndOrderFront(nil)

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            if let title = view.title, !title.isEmpty { self?.window.title = title }
        }
        showStatus("Starting Code Room…")
    }

    func showStatus(_ message: String, detail: String = "") {
        let html = """
        <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#04020c;color:#e8ecff;
        font:14px -apple-system,system-ui;text-align:center"><div><div style="font:800 26px -apple-system;letter-spacing:.2em;
        background:linear-gradient(90deg,#ff5fd2,#ffe14f,#4ff3ff);-webkit-background-clip:text;color:transparent">CODE ROOM</div>
        <p>\(message)</p><p style="color:#8a93c4;font-size:12px;max-width:520px">\(detail)</p></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: server

    func openLog() {
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let file = logs.appendingPathComponent("Code Room.log")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        log = try? FileHandle(forWritingTo: file)
    }

    func pythonPath() -> String? {
        ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func startServer() {
        guard let resources = Bundle.main.resourcePath, let python = pythonPath() else {
            showStatus("Python 3 wasn't found.",
                       detail: "Code Room's scanner needs Python 3. Install it with Homebrew (brew install python) or the Xcode Command Line Tools (xcode-select --install), then reopen the app.")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-I", "-u", resources + "/server.py", "--port", "0", "--exit-with-parent"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"  // so the scanner finds git
        process.environment = env
        let out = Pipe()
        process.standardOutput = out
        process.standardError = log ?? FileHandle.nullDevice

        var buffer = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self?.log?.write(data)
            buffer += String(decoding: data, as: UTF8.self)
            while let newline = buffer.firstIndex(of: "\n") {
                let line = String(buffer[..<newline])
                buffer.removeSubrange(...newline)
                if line.hasPrefix("CODEROOM_READY "),
                   let url = URL(string: line.dropFirst("CODEROOM_READY ".count).trimmingCharacters(in: .whitespaces)) {
                    DispatchQueue.main.async { self?.serverReady(url) }
                }
            }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.pageReady = false
                self.showStatus("The Code Room engine stopped (exit \(proc.terminationStatus)).",
                                detail: "Details are in ~/Library/Logs/Code Room.log. Quit and reopen the app to restart it.")
            }
        }
        do {
            try process.run()
            server = process
        } catch {
            showStatus("Couldn't start the Code Room engine.", detail: error.localizedDescription)
        }
    }

    func serverReady(_ url: URL) {
        serverURL = url
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        if !pendingFolders.isEmpty {
            components.queryItems = [URLQueryItem(name: "root", value: pendingFolders.removeLast())]
            pendingFolders.removeAll()
        }
        webView.load(URLRequest(url: components.url!))
    }

    func isOurPage(_ url: URL?) -> Bool {
        guard let url = url, let base = serverURL else { return false }
        return url.host == base.host && url.port == base.port && url.scheme == base.scheme
    }

    // MARK: opening folders

    func openFolder(_ path: String) {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else {
            NSSound.beep()
            return
        }
        window?.makeKeyAndOrderFront(nil)
        if pageReady {
            callPage("codeRoomOpen", path)
        } else {
            pendingFolders.append(path)
        }
    }

    func callPage(_ function: String, _ argument: String? = nil) {
        var args = "()"
        if let argument = argument,
           let data = try? JSONSerialization.data(withJSONObject: [argument]),
           let json = String(data: data, encoding: .utf8) {
            args = "(..." + json + ")"
        }
        webView.evaluateJavaScript("window.\(function) && window.\(function)\(args)", completionHandler: nil)
    }

    @objc func chooseFolder(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        panel.message = "Choose a repository or source folder to explore"
        panel.beginSheetModal(for: window) { [weak self] response in
            if response == .OK, let url = panel.url { self?.openFolder(url.path) }
        }
    }

    @objc func rescan(_ sender: Any?) { callPage("codeRoomRescan") }
    @objc func find(_ sender: Any?) { callPage("codeRoomFind") }

    // MARK: messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isOurPage(message.frameInfo.request.url) || message.frameInfo.securityOrigin.host == serverURL?.host,
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "pickFolder":
            chooseFolder(nil)
        case "openFile":
            if let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) {
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            }
        case "reveal":
            if let path = body["path"] as? String {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            }
        default:
            break
        }
    }

    // MARK: navigation: stay on our page, send everything else to the default browser

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" || isOurPage(url) { return decisionHandler(.allow) }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isOurPage(webView.url) else { return }
        pageReady = true
        let folders = pendingFolders
        pendingFolders.removeAll()
        if let last = folders.last { callPage("codeRoomOpen", last) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = serverURL { webView.load(URLRequest(url: url)) }
    }

    // MARK: menus

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu(appMenu, title: appName))

        let file = NSMenu(title: "File")
        file.addItem(item("Open Repository…", #selector(chooseFolder(_:)), "o"))
        file.addItem(item("Rescan", #selector(rescan(_:)), "r"))
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(submenu(file, title: "File"))

        // standard Edit items so ⌘C / ⌘V / ⌘A work in the search box
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        edit.addItem(item("Find…", #selector(find(_:)), "f"))
        main.addItem(submenu(edit, title: "Edit"))

        let view = NSMenu(title: "View")
        let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        main.addItem(submenu(view, title: "View"))

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        main.addItem(submenu(windowMenu, title: "Window"))
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func submenu(_ menu: NSMenu, title: String) -> NSMenuItem {
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        return holder
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
