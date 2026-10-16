// Code Room scanner, in JavaScript: the same graph server.py's scan() builds, from a list of files.
// Used where there is no Python to run it (the iPhone app). Same languages, same rules:
//
//     CodeRoomScanner.scan({ root, name, files: [{ path, text }], gomods: { dir: goModText } })
//
// One node per module (foo.h + foo.cpp share one), an edge A → B when A imports / includes B, or uses
// a type that only B declares (Java/Kotlin, C#, Swift, Dart see their package's types without importing).
(() => {
  const PREVIEW_LINES = 60, MAX_FUNC_NAMES = 400, MAX_FILE_BYTES = 1000000, MAX_FILES = 6000, MAX_GROUPS = 24;
  const LANGS = {
    c: ["C/C++", [".h", ".hh", ".hpp", ".hxx", ".c", ".cc", ".cpp", ".cxx", ".m", ".mm", ".inc", ".ipp", ".tpp", ".inl"]],
    js: ["JavaScript/TypeScript", [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]],
    py: ["Python", [".py", ".pyi"]], go: ["Go", [".go"]], rust: ["Rust", [".rs"]],
    jvm: ["Java/Kotlin/Scala", [".java", ".kt", ".kts", ".scala", ".groovy"]], cs: ["C#", [".cs"]], swift: ["Swift", [".swift"]],
    ruby: ["Ruby", [".rb"]], php: ["PHP", [".php"]], lua: ["Lua", [".lua"]], dart: ["Dart", [".dart"]],
  };
  const EXT_LANG = {};
  for (const [lang, [, exts]] of Object.entries(LANGS)) for (const e of exts) EXT_LANG[e] = lang;
  const C_HEADERS = [".h", ".hh", ".hpp", ".hxx"];
  const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".d.ts"];
  const SYMBOL_LANGS = new Set(["jvm", "cs", "swift", "dart"]);
  const SYMBOL_STOP = new Set(("String Object List Map Set Array Int Integer Long Double Float Boolean Bool Void Exception Error Result Option " +
    "Optional Any Data Date Type Self Unit Nothing Char Byte Short Number Task Action Func Thread Runnable Iterable Iterator Collection " +
    "Dictionary Tuple Range URL UUID Main Test").split(" "));
  const GENERIC_STEMS = new Set(["index", "__init__", "mod", "main", "lib", "init", "__main__"]);
  const HARD_IGNORE = new Set([".git", "node_modules", "bower_components", "vendor", "third_party", "Pods", "Carthage"]);
  const WALK_IGNORE = new Set([...HARD_IGNORE, "dist", "build", "out", "target", ".venv", "venv", "env", "__pycache__", ".next", ".nuxt",
    ".svelte-kit", "DerivedData", ".gradle", ".idea", ".vscode", "coverage", ".tox", ".mypy_cache", ".pytest_cache", ".dart_tool", "obj", "bin"]);
  const SKIP_SUFFIXES = [".min.js", ".bundle.js", ".pb.go", "_pb2.py", ".g.dart", ".freezed.dart", ".generated.cs"];

  // ---------- comment / string stripping ----------
  const C_NOISE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  const JS_NOISE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  const RUST_NOISE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[^\n]{1,10}?|[^'\\\n])'/g;
  const HASH_NOISE = /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  const PHP_NOISE = /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  const LUA_NOISE = /--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  const PREPROC_RE = /^[ \t]*#(?:[^\n]*\\\n)*[^\n]*/gm;
  const WORD_RE = /\b[A-Za-z_]\w*\b/g;

  const INCLUDE_RE = /^\s*#\s*(?:include|import)\s*[<"]([^>"]+)[>"]/;
  const C_CLASS_RE = /^\s*(?:class|struct)\s+(\w+)\s*(?:final\s*)?[:{]/gm;
  const OBJC_CLASS_RE = /@(?:interface|implementation|protocol)\s+(\w+)/g;
  const OBJC_METHOD_RE = /^[ \t]*[-+][ \t]*\([^)]*\)[ \t]*(\w+)[^;{]*\{/gm;
  const TRAILING_QUALS_RE = /(?:\s*(?:const|noexcept|override|final|volatile|&&|&|throw\s*\(\s*\)|->\s*[\w:<>*&\s]+))*\s*$/;
  const INIT_LIST_RE = /\)\s*:(?!:)/;
  const CONTROL = new Set(("if for while switch catch return sizeof alignof decltype do else try new delete throw defined static_assert " +
    "synchronized using lock fixed foreach when with elif unless until super this assert yield await typeof nameof checked unchecked match function").split(" "));

  const TYPE_RE = /\b(?:class|interface|enum|record|struct|object|trait|protocol|actor|union|module)\s+([A-Z_]\w*)/g;
  const JS_FUNC_RES = [
    /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=;{]+)?=>)/g,
    /^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?([A-Za-z_$#][\w$]*)\s*(?:<[^>()]*>)?\s*\([^()]*\)\s*(?::\s*[^{;=()]+)?\{/gm,
  ];
  const JS_IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/gm;
  const JS_REQUIRE_RE = /\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
  const PY_DEF_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm;
  const PY_FROM_RE = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm;
  const PY_IMPORT_RE = /^[ \t]*import[ \t]+([^\n]+)/gm;
  const GO_FUNC_RE = /^func[ \t]*(?:\([ \t]*\w*[ \t]*\*?[ \t]*(\w+)[^)]*\)[ \t]*)?(\w+)/gm;
  const GO_TYPE_RE = /^type[ \t]+(\w+)[ \t]+(?:struct|interface)/gm;
  const GO_IMPORT_BLOCK_RE = /^import[ \t]*\(([\s\S]*?)\)/gm;
  const GO_IMPORT_ONE_RE = /^import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm;
  const RS_FN_RE = /\bfn\s+(\w+)/g;
  const RS_MOD_RE = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm;
  const RS_USE_RE = /\buse\s+((?:crate|super|self)(?:::\w+)*)/g;
  const JAVA_METHOD_RE = new RegExp("^[ \\t]*(?:@\\w+(?:\\([^)]*\\))?\\s+)*" +
    "(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|strictfp|virtual|" +
    "override|async|sealed|extern|unsafe|new|partial|readonly|external|factory)\\s+)*" +
    "(?:<[^>]+>\\s+)?(?:[\\w.$<>\\[\\],?]+\\s+)?(\\w+)\\s*\\([^;{}]*?\\)\\s*(?:throws\\s+[\\w.,\\s]+)?(?:where\\s+[^{]+)?(?:\\{|=>)", "gm");
  const KT_FUN_RE = /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/g;
  const DEF_RE = /\bdef\s+(\w+)/g;
  const JVM_IMPORT_RE = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+(?:\.\*)?)/gm;
  const SWIFT_FUNC_RE = /\bfunc\s+(\w+)/g;
  const RB_DEF_RE = /^[ \t]*def[ \t]+(?:self\.)?([\w?!=]+)/gm;
  const RB_REQ_RE = /\brequire(_relative)?\s*\(?\s*["']([^"'\n]+)["']/g;
  const PHP_FUNC_RE = /\bfunction\s+&?\s*(\w+)\s*\(/g;
  const PHP_INC_RE = /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']([^"'\n]+)["']/g;
  const PHP_USE_RE = /^[ \t]*use[ \t]+([\w\\]+)/gm;
  const LUA_FUNC_RE = /\bfunction\s+([\w.:]+)\s*\(|([\w.]+)\s*=\s*function\s*\(/g;
  const LUA_REQ_RE = /\brequire\s*\(?\s*["']([^"'\n]+)["']/g;
  const DART_IMPORT_RE = /^[ \t]*(?:import|export|part)[ \t]+["']([^"'\n]+)["']/gm;

  const all = (re, s, g = 1) => { const out = []; re.lastIndex = 0; for (const m of s.matchAll(re)) out.push(m[g]); return out; };
  const groups = (re, s) => { re.lastIndex = 0; return [...s.matchAll(re)]; };
  const strip = (re, s) => s.replace(re, " ");
  const notControl = (names) => names.filter((n) => n && !CONTROL.has(n));

  // ---------- paths (posixpath) ----------
  const dirname = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
  const splitext = (p) => { const b = basename(p), i = b.lastIndexOf("."); return i <= 0 ? [p, ""] : [p.slice(0, p.length - b.length + i), b.slice(i)]; };
  const join = (...ps) => ps.filter((p, i) => p !== "" || i === ps.length - 1).reduce((a, b) => (b.startsWith("/") ? b : a ? (a.endsWith("/") ? a + b : a + "/" + b) : b), "");
  function normpath(p) {
    const abs = p.startsWith("/"), out = [];
    for (const s of p.split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); }
      else out.push(s);
    }
    return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
  }

  // ---------- C / C++ function bodies ----------
  function functionName(head) {
    head = head.split(/\s+/).filter(Boolean).join(" ");
    const m = INIT_LIST_RE.exec(head);
    if (m) head = head.slice(0, m.index + 1);
    head = head.replace(TRAILING_QUALS_RE, "");
    if (!head.endsWith(")") || head.split("(")[0].includes("=")) return null;
    let depth = 0, i = head.length - 1;
    for (; i >= 0; i--) {
      if (head[i] === ")") depth++;
      else if (head[i] === "(") { depth--; if (depth === 0) break; }
    }
    if (i < 0) return null;
    const n = /((?:[\w~]+::)*(?:operator\s*\S+?|operator\s*\(\s*\)|~?\w+))\s*$/.exec(head.slice(0, i));
    if (!n) return null;
    const name = n[1].replace(/ /g, "");
    const last = name.split("::").pop();
    if (CONTROL.has(last) || /^\d/.test(name)) return null;
    return name;
  }
  function findCFunctions(code) {
    const stack = [], names = [];
    let seg = 0;
    for (const m of code.matchAll(/[{};]/g)) {
      const i = m.index, c = m[0];
      if (c === "{") {
        const head = code.slice(seg, i);
        let kind;
        if (stack.some((k) => k === "func" || k === "block")) kind = "block";
        else {
          const tail = /\b(public|private|protected)\s*:/.test(head) ? head.slice(head.lastIndexOf(":") + 1) : head;
          const name = functionName(tail);
          if (name) { kind = "func"; names.push(name); }
          else if (/\bnamespace\b|\bextern\s*$/.test(head) || /\b(class|struct|union|enum)\b/.test(head)) kind = "scope";
          else kind = "block";
        }
        stack.push(kind); seg = i + 1;
      } else { if (c === "}" && stack.length) stack.pop(); seg = i + 1; }
    }
    return names;
  }
  function pyNames(chunk) {
    chunk = chunk.trim().replace(/^[()]+|[()]+$/g, "");
    const out = [];
    for (const part of chunk.replace(/\n/g, " ").split(",")) {
      const w = part.trim().split(" ")[0];
      if (w && w !== "*" && /^\w+$/.test(w)) out.push(w);
    }
    return out;
  }

  // -> [noise-stripped code, function names, type names, raw import specs]
  function analyse(lang, ext, text, lines) {
    switch (lang) {
      case "c": {
        const code = strip(PREPROC_RE, strip(C_NOISE, text));
        let funcs = findCFunctions(code), classes = all(C_CLASS_RE, text);
        if (ext === ".m" || ext === ".mm") { funcs = funcs.concat(all(OBJC_METHOD_RE, code)); classes = classes.concat(all(OBJC_CLASS_RE, code)); }
        return [code, funcs, classes, lines.map((l) => INCLUDE_RE.exec(l)).filter(Boolean).map((m) => m[1])];
      }
      case "js": {
        const code = strip(JS_NOISE, text);
        let funcs = [];
        for (const rx of JS_FUNC_RES) funcs = funcs.concat(notControl(all(rx, code)));
        return [code, funcs, all(TYPE_RE, code), all(JS_IMPORT_RE, text).concat(all(JS_REQUIRE_RE, text))];
      }
      case "py": {
        const code = strip(HASH_NOISE, text);
        const imports = groups(PY_FROM_RE, code).map((m) => ["from", m[1], m[2], pyNames(m[3])]);
        for (const chunk of all(PY_IMPORT_RE, code)) for (const p of chunk.split(",")) if (p.trim()) imports.push(["import", p.trim().split(" ")[0]]);
        return [code, all(PY_DEF_RE, code), all(TYPE_RE, code), imports];
      }
      case "go": {
        const code = strip(C_NOISE, text);
        const funcs = groups(GO_FUNC_RE, code).map((m) => (m[1] ? `${m[1]}.${m[2]}` : m[2]));
        let imports = all(GO_IMPORT_ONE_RE, text);
        for (const block of all(GO_IMPORT_BLOCK_RE, text)) imports = imports.concat(all(/"([^"]+)"/g, block));
        return [code, funcs, all(GO_TYPE_RE, code), imports];
      }
      case "rust": {
        const code = strip(RUST_NOISE, text);
        return [code, all(RS_FN_RE, code), all(TYPE_RE, code), all(RS_MOD_RE, code).map((m) => ["mod", m]).concat(all(RS_USE_RE, code).map((u) => ["use", u]))];
      }
      case "jvm": {
        const code = strip(C_NOISE, text);
        const funcs = ext === ".kt" || ext === ".kts" ? all(KT_FUN_RE, code) : ext === ".scala" ? all(DEF_RE, code) : notControl(all(JAVA_METHOD_RE, code));
        return [code, funcs, all(TYPE_RE, code), all(JVM_IMPORT_RE, code)];
      }
      case "cs": case "dart": {
        const code = strip(C_NOISE, text);
        return [code, notControl(all(JAVA_METHOD_RE, code)), all(TYPE_RE, code), lang === "dart" ? all(DART_IMPORT_RE, text) : []];
      }
      case "swift": { const code = strip(C_NOISE, text); return [code, all(SWIFT_FUNC_RE, code), all(TYPE_RE, code), []]; }
      case "ruby": { const code = strip(HASH_NOISE, text); return [code, all(RB_DEF_RE, code), all(TYPE_RE, code), groups(RB_REQ_RE, text).map((m) => [m[1] || "", m[2]])]; }
      case "php": {
        const code = strip(PHP_NOISE, text);
        return [code, all(PHP_FUNC_RE, code), all(TYPE_RE, code), all(PHP_INC_RE, text).map((s) => ["inc", s]).concat(all(PHP_USE_RE, code).map((u) => ["use", u]))];
      }
      case "lua": { const code = strip(LUA_NOISE, text); return [code, groups(LUA_FUNC_RE, code).map((m) => m[1] || m[2]), [], all(LUA_REQ_RE, text)]; }
    }
    return [text, [], [], []];
  }

  function hash(s) {      // a quick content fingerprint (server.py uses sha1; only equality matters)
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13); }
    return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0"));
  }
  function counter(words) { const m = new Map(); for (const w of words) m.set(w, (m.get(w) || 0) + 1); return m; }

  function parseFile(lang, ext, text) {
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const [code, functions, classes, imports] = analyse(lang, ext, text, lines);
    return { loc: lines.length, sha: hash(text), functions, classes, imports, words: counter(code.match(WORD_RE) || []), preview: lines.slice(0, PREVIEW_LINES).join("\n") };
  }

  // ---------- which files count ----------
  // files: [{ path, text }] (paths relative to the repository, "/"-separated)
  function listFiles(files, { walked = true } = {}) {
    const out = new Map(), gomods = {};
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const parts = f.path.split("/");
      if (parts.slice(0, -1).some((p) => HARD_IGNORE.has(p) || (walked && (p.startsWith(".") || WALK_IGNORE.has(p))))) continue;
      const name = parts[parts.length - 1];
      if (name === "go.mod") { gomods[dirname(f.path)] = f.text; continue; }
      const ext = splitext(name)[1], lang = EXT_LANG[ext] || EXT_LANG[ext.toLowerCase()];
      if (!lang || SKIP_SUFFIXES.some((s) => name.endsWith(s)) || f.text == null || f.text.length > MAX_FILE_BYTES) continue;
      out.set(f.path, { lang, ext, text: f.text });
    }
    const truncated = out.size > MAX_FILES;
    if (truncated) { const keep = [...out.keys()].slice(0, MAX_FILES); for (const k of [...out.keys()]) if (!keep.includes(k)) out.delete(k); }
    return { files: out, gomods, truncated };
  }
  const wanted = (path) => {             // worth fetching at all (for sources that list before they read)
    const parts = path.split("/");
    if (parts.slice(0, -1).some((p) => HARD_IGNORE.has(p) || p.startsWith(".") || WALK_IGNORE.has(p))) return false;
    const name = parts[parts.length - 1];
    if (name === "go.mod") return true;
    const ext = splitext(name)[1];
    return !!(EXT_LANG[ext] || EXT_LANG[ext.toLowerCase()]) && !SKIP_SUFFIXES.some((s) => name.endsWith(s));
  };

  // ---------- modules ----------
  const moduleId = (rel, lang) => (lang === "go" ? dirname(rel) || "(root)" : splitext(rel)[0]);
  function displayName(mod, lang, rootName) {
    if (mod === "(root)") return rootName;
    const base = basename(mod), parent = basename(dirname(mod));
    return lang !== "go" && GENERIC_STEMS.has(base) && parent ? `${parent}/${base}` : base;
  }
  function assignGroups(mods) {
    const g = new Map(mods.map((m) => [m, m === "(root)" ? "" : dirname(m)]));
    for (;;) {
      const names = new Set(g.values());
      if (names.size <= MAX_GROUPS) break;
      const deepest = Math.max(...[...names].map((x) => (x ? x.split("/").length : 0)));
      if (deepest === 0) break;
      for (const [m, x] of g) if (x && x.split("/").length === deepest) g.set(m, dirname(x));
    }
    for (const [m, x] of g) g.set(m, x || "(root)");
    return g;
  }

  class Resolver {
    constructor(files, gomods) {
      this.rels = new Set(files.keys());
      this.modOf = new Map(); this.byBase = new Map(); this.byStem = new Map(); this.goDirs = new Map();
      const push = (map, k, v) => { let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(v); };
      for (const [rel, f] of files) {
        this.modOf.set(rel, moduleId(rel, f.lang));
        const base = basename(rel);
        push(this.byBase, base, rel); push(this.byStem, splitext(base)[0], rel);
        if (f.lang === "go") push(this.goDirs, dirname(rel), rel);
      }
      this.jvmRels = [...files].filter(([, f]) => f.lang === "jvm").map(([r]) => r);
      this.goMods = [];
      for (const [d, text] of Object.entries(gomods)) { const m = /^module\s+(\S+)/m.exec(text || ""); if (m) this.goMods.push([d, m[1]]); }
      this.goMods.sort((a, b) => b[1].length - a[1].length);
      const py = [...files].filter(([, f]) => f.lang === "py").map(([r]) => r);
      const packages = new Set(py.filter((r) => ["__init__.py", "__init__.pyi"].includes(basename(r))).map(dirname));
      this.pyIndex = new Map(); this.pyPkg = new Map();
      for (const r of py) {
        const dirs = r.split("/").slice(0, -1);
        let k = dirs.length;
        while (k > 0 && packages.has(dirs.slice(0, k).join("/"))) k--;
        this.pyPkg.set(r, dirs.slice(k).join("."));
        for (const start of [k, 0]) {
          let parts = splitext(r)[0].split("/").slice(start);
          if (parts.length && parts[parts.length - 1] === "__init__") parts = parts.slice(0, -1);
          if (parts.length && !this.pyIndex.has(parts.join("."))) this.pyIndex.set(parts.join("."), r);
        }
      }
    }
    best(cands, rel) {
      if (cands.length <= 1) return [...cands];
      const here = rel.split("/");
      const score = (c) => { const cs = c.split("/"); let n = 0; while (n < here.length && n < cs.length && here[n] === cs[n]) n++; return [-n, cs.length - 1, c]; };
      const cmp = (a, b) => { const x = score(a), y = score(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };
      return [[...cands].sort(cmp)[0]];
    }
    suffix(path, exts) {
      const out = [];
      for (const r of this.byStem.get(basename(path)) || []) {
        const [base, ext] = splitext(r);
        if (exts.includes(ext) && (base === path || base.endsWith("/" + path))) out.push(r);
      }
      return out;
    }
    resolve(lang, rel, imp) {
      const fn = this["r_" + lang];
      return (fn ? fn.call(this, rel, imp) : []).filter((r) => this.modOf.has(r)).map((r) => this.modOf.get(r));
    }
    r_c(rel, spec) {
      const here = dirname(rel);
      for (const cand of [normpath(join(here, spec)), normpath(spec)]) if (this.rels.has(cand)) return [cand];
      return this.best((this.byBase.get(basename(spec)) || []).filter((r) => r.endsWith("/" + spec)), rel);
    }
    r_js(rel, spec) {
      spec = spec.split("?")[0].split("#")[0];
      if (!spec) return [];
      const srcDirs = [];
      for (let d = dirname(rel); d; d = dirname(d)) if (basename(d) === "src") srcDirs.push(d);
      let bases;
      if (spec.startsWith(".")) bases = [normpath(join(dirname(rel), spec))];
      else if (spec.startsWith("@/") || spec.startsWith("~/")) bases = srcDirs.map((s) => join(s, spec.slice(2))).concat(["src/" + spec.slice(2), spec.slice(2)]);
      else if (spec.startsWith("/")) bases = [spec.replace(/^\/+/, "")];
      else bases = srcDirs.map((s) => join(s, spec)).concat([spec, "src/" + spec]);
      for (const b of bases) {
        let tries = [b];
        if (/\.(js|jsx|mjs|cjs)$/.test(b)) { const stem = splitext(b)[0]; tries = tries.concat([".ts", ".tsx", ".mts", ".cts"].map((e) => stem + e)); }
        tries = tries.concat(JS_EXTS.map((e) => b + e), JS_EXTS.map((e) => b + "/index" + e));
        for (const t of tries) if (this.rels.has(t)) return [t];
      }
      return [];
    }
    r_py(rel, imp) {
      const idx = this.pyIndex;
      if (imp[0] === "import") {
        const parts = imp[1].split(".");
        for (let n = parts.length; n > 0; n--) { const r = idx.get(parts.slice(0, n).join(".")); if (r) return [r]; }
        return [];
      }
      const [, dots, mod, names] = imp;
      let full;
      if (dots) {
        const base = this.pyPkg.get(rel) || "";
        let parts = base ? base.split(".") : [];
        const up = dots.length - 1;
        if (up) parts = up < parts.length ? parts.slice(0, -up) : [];
        full = parts.concat(mod ? mod.split(".") : []);
      } else full = mod.split(".");
      const prefix = full.join(".");
      const out = names.map((nm) => (prefix ? prefix + "." + nm : nm)).filter((k) => idx.has(k)).map((k) => idx.get(k));
      if (!out.length) for (let n = full.length; n > 0; n--) { const r = idx.get(full.slice(0, n).join(".")); if (r) return [r]; }
      return out;
    }
    r_go(rel, spec) {
      for (const [moddir, modpath] of this.goMods) {
        if (spec === modpath || spec.startsWith(modpath + "/")) {
          const sub = spec.slice(modpath.length).replace(/^\/+/, "");
          let d = moddir || sub ? normpath(join(moddir, sub)) : "";
          if (d === ".") d = "";
          const hit = this.goDirs.get(d);
          if (hit && hit.length) return [hit[0]];
        }
      }
      return [];
    }
    crateRoot(d) {
      for (;;) {
        if (this.rels.has(join(d, "lib.rs")) || this.rels.has(join(d, "main.rs"))) return d;
        if (!d) return [...this.rels].some((r) => r.startsWith("src/")) ? "src" : "";
        d = dirname(d);
      }
    }
    r_rust(rel, [kind, path]) {
      const d = dirname(rel), stem = splitext(basename(rel))[0];
      const cur = ["mod", "lib", "main"].includes(stem) ? d : join(d, stem);
      const find = (base, segs) => {
        for (let n = segs.length; n > 0; n--) {
          const p = join(base, ...segs.slice(0, n));
          for (const c of [p + ".rs", p + "/mod.rs"]) if (this.rels.has(c)) return [c];
        }
        return [];
      };
      if (kind === "mod") return find(cur, [path]);
      let segs = path.split("::"), base;
      if (segs[0] === "crate") { base = this.crateRoot(d); segs = segs.slice(1); }
      else { base = cur; while (segs.length && (segs[0] === "self" || segs[0] === "super")) { if (segs[0] === "super") base = dirname(base); segs = segs.slice(1); } }
      return segs.length ? find(base, segs) : [];
    }
    r_jvm(rel, spec) {
      const exts = LANGS.jvm[1];
      if (spec.endsWith(".*")) {
        const pkg = spec.slice(0, -2).replace(/\./g, "/");
        return this.jvmRels.filter((r) => dirname(r) === pkg || dirname(r).endsWith("/" + pkg)).slice(0, 40);
      }
      const parts = spec.split(".");
      for (let n = parts.length; n > 1; n--) { const hit = this.suffix(parts.slice(0, n).join("/"), exts); if (hit.length) return this.best(hit, rel); }
      return [];
    }
    r_dart(rel, spec) {
      if (spec.startsWith("dart:")) return [];
      if (spec.startsWith("package:")) {
        const rest = spec.includes("/") ? spec.slice(spec.indexOf("/") + 1) : "", cand = "lib/" + rest;
        return this.rels.has(cand) ? [cand] : this.best(this.suffix(splitext(rest)[0], [".dart"]), rel);
      }
      const p = normpath(join(dirname(rel), spec));
      return this.rels.has(p) ? [p] : [];
    }
    r_ruby(rel, [relative, spec]) {
      if (spec.endsWith(".rb")) spec = spec.slice(0, -3);
      if (relative) { const p = normpath(join(dirname(rel), spec)) + ".rb"; return this.rels.has(p) ? [p] : []; }
      return this.best(this.suffix(spec, [".rb"]), rel);
    }
    r_php(rel, [kind, spec]) {
      if (kind === "inc") {
        const p = normpath(join(dirname(rel), spec.replace(/^\/+/, "")));
        if (this.rels.has(p)) return [p];
        return this.best(this.suffix(splitext(spec.replace(/^[./]+/, ""))[0], [".php"]), rel);
      }
      const parts = spec.split("\\").filter(Boolean);
      for (let n = parts.length; n > 0; n--) { const hit = this.suffix(parts.slice(-n).join("/"), [".php"]); if (hit.length && (n > 1 || hit.length === 1)) return this.best(hit, rel); }
      return [];
    }
    r_lua(rel, spec) {
      const p = spec.replace(/\./g, "/");
      const a = this.suffix(p, [".lua"]);
      return this.best(a.length ? a : this.suffix(p + "/init", [".lua"]), rel);
    }
  }

  // ---------- the graph ----------
  function scan({ root = "", name = "", files = [], walked = true } = {}) {
    const t0 = Date.now();
    const { files: list, gomods, truncated } = listFiles(files, { walked });
    const rootName = name || basename(root.replace(/\/+$/, "")) || root;
    const res = new Resolver(list, gomods);
    const nodes = new Map(), words = new Map(), edges = new Map(), langs = new Map();
    for (const [rel, f] of list) {
      const pf = parseFile(f.lang, f.ext, f.text), mod = res.modOf.get(rel);
      langs.set(LANGS[f.lang][0], (langs.get(LANGS[f.lang][0]) || 0) + 1);
      let node = nodes.get(mod);
      if (!node) {
        node = { id: mod, name: displayName(mod, f.lang, rootName), group: "", lang: LANGS[f.lang][0], _lang: f.lang, files: [], loc: 0, funcs: 0,
                 functions: [], classes: [], preview: "", previewFile: "", hash: "" };
        nodes.set(mod, node); words.set(mod, new Map());
      }
      node.files.push(rel); node.loc += pf.loc;
      node.hash = hash(node.hash + rel + pf.sha).slice(0, 12);
      node.funcs += pf.functions.length;
      for (const fn of pf.functions) node.functions.push(fn);
      const w = words.get(mod);
      for (const [k, v] of pf.words) w.set(k, (w.get(k) || 0) + v);
      for (const c of pf.classes) if (!node.classes.includes(c)) node.classes.push(c);
      const prefer = f.lang === "c" ? C_HEADERS.some((e) => rel.endsWith(e)) : f.lang === "go" && !rel.endsWith("_test.go");
      if (!node.preview || (prefer && !node._preferred)) { node.preview = pf.preview; node.previewFile = rel; node._preferred = prefer; }
      for (const imp of pf.imports) for (const target of res.resolve(f.lang, rel, imp)) {
        if (target !== mod) { const k = mod + "\u0000" + target; edges.set(k, (edges.get(k) || 0) + 1); }
      }
    }
    const refs = new Map();
    for (const k of edges.keys()) {
      const [s, t] = k.split("\u0000"), tn = nodes.get(t), names = new Set([...tn.classes, tn.name, basename(t)]), ws = words.get(s);
      let sum = 0; for (const nm of names) sum += ws.get(nm) || 0;
      refs.set(k, Math.max(1, sum));
    }
    // same-package type references
    const declared = new Map();
    for (const [mod, n] of nodes) {
      if (!SYMBOL_LANGS.has(n._lang)) continue;
      let byName = declared.get(n._lang); if (!byName) declared.set(n._lang, (byName = new Map()));
      for (const c of n.classes) if (c.length >= 3 && /^[A-Z]/.test(c) && !SYMBOL_STOP.has(c)) { let s = byName.get(c); if (!s) byName.set(c, (s = new Set())); s.add(mod); }
    }
    for (const [lang, byName] of declared) {
      const unique = new Map();
      for (const [c, ms] of byName) if (ms.size === 1) unique.set(c, [...ms][0]);
      for (const [mod, n] of nodes) {
        if (n._lang !== lang) continue;
        for (const [c, cnt] of words.get(mod)) {
          const t = unique.get(c);
          if (t && t !== mod && !edges.has(mod + "\u0000" + t)) { const k = mod + "\u0000" + t; refs.set(k, (refs.get(k) || 0) + cnt); }
        }
      }
    }
    for (const [mod, g] of assignGroups([...nodes.keys()])) nodes.get(mod).group = g;
    for (const n of nodes.values()) { n.classes = n.classes.slice(0, 24); n.functions = n.functions.slice(0, MAX_FUNC_NAMES); delete n._lang; delete n._preferred; }
    const links = [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, r]) => {
      const [s, t] = k.split("\u0000");
      return { source: s, target: t, count: edges.get(k) || 0, refs: r, via: edges.has(k) ? "import" : "symbol" };
    });
    const languages = Object.fromEntries([...langs.entries()].sort((a, b) => b[1] - a[1]));
    return { root, name: rootName, scannedAt: Date.now() / 1000, scanMs: Date.now() - t0, viaGit: false, truncated, fileCount: list.size,
             languages, nodes: [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), links };
  }

  window.CodeRoomScanner = { scan, wanted, languages: Object.values(LANGS).map(([n]) => n), MAX_FILES, MAX_FILE_BYTES };
})();
