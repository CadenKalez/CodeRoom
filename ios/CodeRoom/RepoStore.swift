import Foundation

/// Folders picked in the Files app. Each is remembered by a bookmark (so it can be read again after the
/// app restarts, and re-read for Update), and handed to the page as JSON: { name, files: [{ path, text }] }.
/// Code Room only reads them; nothing is ever written into a picked folder.
final class RepoStore {
    static let shared = RepoStore()
    private let key = "coderoom.folders"                          // id → { name, bookmark }

    // the same limits and skips as server.py / scanner.js
    private static let maxFiles = 6000, maxBytes = 1_000_000
    private static let ignore: Set<String> = [".git", "node_modules", "bower_components", "vendor", "third_party", "Pods", "Carthage",
        "dist", "build", "out", "target", ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".svelte-kit", "DerivedData",
        ".gradle", ".idea", ".vscode", "coverage", ".tox", ".mypy_cache", ".pytest_cache", ".dart_tool", "obj", "bin"]
    private static let exts: Set<String> = ["h", "hh", "hpp", "hxx", "c", "cc", "cpp", "cxx", "m", "mm", "inc", "ipp", "tpp", "inl",
        "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte", "py", "pyi", "go", "rs", "java", "kt", "kts", "scala",
        "groovy", "cs", "swift", "rb", "php", "lua", "dart"]

    /// Remembers a picked folder; returns its id.
    func remember(folder url: URL) -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else { return nil }
        var all = UserDefaults.standard.dictionary(forKey: key) ?? [:]
        // the same folder picked again keeps its id (and its place in the recent list)
        let id = all.first(where: { ($0.value as? [String: Any])?["path"] as? String == url.path })?.key ?? UUID().uuidString
        all[id] = ["name": url.lastPathComponent, "path": url.path, "bookmark": bookmark]
        UserDefaults.standard.set(all, forKey: key)
        return id
    }

    /// The folder's source files, read now.
    func json(for id: String) -> Data? {
        guard let entry = UserDefaults.standard.dictionary(forKey: key)?[id] as? [String: Any],
              let bookmark = entry["bookmark"] as? Data else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if stale { _ = remember(folder: url) }

        var files: [[String: String]] = []
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .fileSizeKey]
        guard let walker = fm.enumerator(at: url, includingPropertiesForKeys: keys, options: [.skipsPackageDescendants]) else { return nil }
        let base = url.standardizedFileURL.path
        for case let file as URL in walker {
            let name = file.lastPathComponent
            let values = try? file.resourceValues(forKeys: Set(keys))
            if values?.isDirectory == true {
                if name.hasPrefix(".") || Self.ignore.contains(name) { walker.skipDescendants() }
                continue
            }
            guard values?.isRegularFile == true, (values?.fileSize ?? 0) <= Self.maxBytes else { continue }
            let ext = file.pathExtension.lowercased()
            guard name == "go.mod" || Self.exts.contains(ext) else { continue }
            guard let data = try? Data(contentsOf: file) else { continue }
            var rel = file.standardizedFileURL.path
            if rel.hasPrefix(base) { rel = String(rel.dropFirst(base.count)) }
            if rel.hasPrefix("/") { rel.removeFirst() }
            files.append(["path": rel, "text": String(decoding: data, as: UTF8.self)])
            if files.count >= Self.maxFiles * 2 { break }
        }
        return try? JSONSerialization.data(withJSONObject: ["name": entry["name"] as? String ?? url.lastPathComponent, "files": files])
    }
}
