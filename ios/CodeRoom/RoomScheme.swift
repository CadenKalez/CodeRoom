import Foundation
import WebKit

/// Serves the room at coderoom://app/…:
///   index.html, sound.js, scanner.js, samples/…, music/…   from the bundled www/ folder
///   local/<id>.json                                         a folder picked in Files, read fresh each time
///   music/remote/<id>                                       a scene classic from The Mod Archive, cached
final class RoomScheme: NSObject, WKURLSchemeHandler {
    static let name = "coderoom"
    private let www = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true)
    private var live = Set<ObjectIdentifier>()                  // tasks not stopped yet (answering a stopped one throws)
    private let lock = NSLock()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); live.insert(ObjectIdentifier(task)); lock.unlock()
        guard let url = task.request.url else { return fail(task, 400) }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let parts = path.split(separator: "/").map(String.init)

        if parts.count == 2, parts[0] == "local", parts[1].hasSuffix(".json") {
            let id = String(parts[1].dropLast(5))
            DispatchQueue.global(qos: .userInitiated).async {
                if let data = RepoStore.shared.json(for: id) { self.reply(task, url, data, "application/json") }
                else { self.fail(task, 404) }
            }
            return
        }
        if parts.count == 3, parts[0] == "music", parts[1] == "remote", let id = Int(parts[2]) {
            ModuleFetcher.shared.module(id, allowed: allowedRemoteIDs()) { data in
                if let data { self.reply(task, url, data, "application/octet-stream") } else { self.fail(task, 502) }
            }
            return
        }
        // a bundled file: plain names under www/ only, never a way out of it
        guard !parts.contains(where: { $0 == ".." || $0.hasPrefix(".") }) else { return fail(task, 403) }
        let file = parts.reduce(www) { $0.appendingPathComponent($1) }
        DispatchQueue.global(qos: .userInitiated).async {
            if let data = try? Data(contentsOf: file) { self.reply(task, url, data, Self.mime(file.pathExtension)) }
            else { self.fail(task, 404) }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); live.remove(ObjectIdentifier(task)); lock.unlock()
    }

    private func reply(_ task: WKURLSchemeTask, _ url: URL, _ data: Data, _ mime: String) {
        DispatchQueue.main.async {
            guard self.take(task) else { return }
            let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"]
            task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
            task.didReceive(data)
            task.didFinish()
        }
    }

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        DispatchQueue.main.async {
            guard self.take(task), let url = task.request.url else { return }
            task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!)
            task.didReceive(Data())
            task.didFinish()
        }
    }

    private func take(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live.remove(ObjectIdentifier(task)) != nil
    }

    /// Only modules listed as "remote" in the bundled playlist are ever fetched.
    private func allowedRemoteIDs() -> Set<Int> {
        guard let data = try? Data(contentsOf: www.appendingPathComponent("music/playlist.json")),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return Set(list.compactMap { $0["remote"] as? Int })
    }

    static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "json": return "application/json"
        case "m4a": return "audio/mp4"
        case "flac": return "audio/flac"
        case "mp3": return "audio/mpeg"
        case "png": return "image/png"
        case "py", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}

/// Scene classics (keygen and cracktro tunes) may only be passed on as the original, unbundled file, so
/// they aren't in the app: the first time the radio picks one it's downloaded from The Mod Archive into
/// the app's cache, the same as saving it from the site.
final class ModuleFetcher {
    static let shared = ModuleFetcher()
    private let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("modules", isDirectory: true)

    func module(_ id: Int, allowed: Set<Int>, done: @escaping (Data?) -> Void) {
        guard allowed.contains(id) else { return done(nil) }
        let file = dir.appendingPathComponent("\(id).bin")
        if let data = try? Data(contentsOf: file) { return done(data) }
        var req = URLRequest(url: URL(string: "https://api.modarchive.org/downloads.php?moduleid=\(id)")!, timeoutInterval: 20)
        req.setValue("CodeRoom/1.1 (iPhone)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data, data.count < 4 << 20, Self.looksLikeModule(data) else { return done(nil) }
            try? FileManager.default.createDirectory(at: self.dir, withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
            done(data)
        }.resume()
    }

    private static func looksLikeModule(_ d: Data) -> Bool {
        if d.count > 17, String(decoding: d.prefix(17), as: UTF8.self) == "Extended Module: " { return true }
        guard d.count > 1084 else { return false }
        let tag = String(decoding: d[1080..<1084], as: UTF8.self)
        return ["M.K.", "M!K!", "4CHN", "FLT4"].contains(tag)
    }
}
