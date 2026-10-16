#!/usr/bin/env python3
"""Code Room server: scans a source tree (read-only) and serves a bubble
visualization of its dependency graph, in a browser or inside Code Room.app.

    python3 server.py --open                       # pick any repo from the page
    python3 server.py --src ~/code/my-repo --open  # open straight into a repo
    python3 server.py --port 0                     # any free port; prints "CODEROOM_READY <url>"

Languages: C/C++/Objective-C, JavaScript/TypeScript, Python, Go, Rust,
Java/Kotlin/Scala, C#, Swift, Ruby, PHP, Lua and Dart.

Nothing is ever written into a scanned tree. The only file this writes is the
recent-repositories list in the user's config folder.
"""
import argparse
import email.utils
import hashlib
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
PREVIEW_LINES = 60
MAX_FUNC_NAMES = 400
MAX_FILE_BYTES = 1_000_000
MAX_FILES = 6000
MAX_GROUPS = 24
MAX_RECENT = 12

LANGS = {  # id: (display name, extensions)
    "c": ("C/C++", (".h", ".hh", ".hpp", ".hxx", ".c", ".cc", ".cpp", ".cxx", ".m", ".mm", ".inc", ".ipp", ".tpp", ".inl")),
    "js": ("JavaScript/TypeScript", (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte")),
    "py": ("Python", (".py", ".pyi")),
    "go": ("Go", (".go",)),
    "rust": ("Rust", (".rs",)),
    "jvm": ("Java/Kotlin/Scala", (".java", ".kt", ".kts", ".scala", ".groovy")),
    "cs": ("C#", (".cs",)),
    "swift": ("Swift", (".swift",)),
    "ruby": ("Ruby", (".rb",)),
    "php": ("PHP", (".php",)),
    "lua": ("Lua", (".lua",)),
    "dart": ("Dart", (".dart",)),
}
EXT_LANG = {ext: lang for lang, (_, exts) in LANGS.items() for ext in exts}
C_HEADERS = (".h", ".hh", ".hpp", ".hxx")
JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".d.ts")
# languages whose files see each other's types without importing them (same package / module)
SYMBOL_LANGS = {"jvm", "cs", "swift", "dart"}
SYMBOL_STOP = {
    "String", "Object", "List", "Map", "Set", "Array", "Int", "Integer", "Long", "Double", "Float", "Boolean",
    "Bool", "Void", "Exception", "Error", "Result", "Option", "Optional", "Any", "Data", "Date", "Type", "Self",
    "Unit", "Nothing", "Char", "Byte", "Short", "Number", "Task", "Action", "Func", "Thread", "Runnable",
    "Iterable", "Iterator", "Collection", "Dictionary", "Tuple", "Range", "URL", "UUID", "Main", "Test",
}
GENERIC_STEMS = {"index", "__init__", "mod", "main", "lib", "init", "__main__"}
# folders never worth drawing (applied on top of .gitignore when git lists the files)
HARD_IGNORE = {".git", "node_modules", "bower_components", "vendor", "third_party", "Pods", "Carthage"}
WALK_IGNORE = HARD_IGNORE | {
    "dist", "build", "out", "target", ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".svelte-kit",
    "DerivedData", ".gradle", ".idea", ".vscode", "coverage", ".tox", ".mypy_cache", ".pytest_cache",
    ".dart_tool", "obj", "bin",
}
SKIP_SUFFIXES = (".min.js", ".bundle.js", ".pb.go", "_pb2.py", ".g.dart", ".freezed.dart", ".generated.cs")

# ---------- comment / string stripping ----------
C_NOISE = re.compile(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', re.S)
JS_NOISE = re.compile(r'//[^\n]*|/\*.*?\*/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', re.S)
RUST_NOISE = re.compile(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\[^\n]{1,10}?|[^\'\\\n])\'', re.S)
HASH_NOISE = re.compile(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|#[^\n]*|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'')
PHP_NOISE = re.compile(r'//[^\n]*|#[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', re.S)
LUA_NOISE = re.compile(r'--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'')
PREPROC_RE = re.compile(r'^[ \t]*#(?:[^\n]*\\\n)*[^\n]*', re.M)
WORD_RE = re.compile(r'\b[A-Za-z_]\w*\b')

# ---------- C / C++ function bodies (brace-scope parser) ----------
INCLUDE_RE = re.compile(r'^\s*#\s*(?:include|import)\s*[<"]([^>"]+)[>"]')
C_CLASS_RE = re.compile(r'^\s*(?:class|struct)\s+(\w+)\s*(?:final\s*)?[:{]', re.M)
OBJC_CLASS_RE = re.compile(r'@(?:interface|implementation|protocol)\s+(\w+)')
OBJC_METHOD_RE = re.compile(r'^[ \t]*[-+][ \t]*\([^)]*\)[ \t]*(\w+)[^;{]*\{', re.M)
BRACE_RE = re.compile(r'[{};]')
TRAILING_QUALS_RE = re.compile(r'(?:\s*(?:const|noexcept|override|final|volatile|&&|&|throw\s*\(\s*\)|->\s*[\w:<>\*&\s]+))*\s*$')
INIT_LIST_RE = re.compile(r'\)\s*:(?!:)')
CONTROL = {
    "if", "for", "while", "switch", "catch", "return", "sizeof", "alignof", "decltype", "do", "else", "try",
    "new", "delete", "throw", "defined", "static_assert", "synchronized", "using", "lock", "fixed", "foreach",
    "when", "with", "elif", "unless", "until", "super", "this", "assert", "yield", "await", "typeof", "nameof",
    "checked", "unchecked", "match", "function",
}

# ---------- other languages ----------
TYPE_RE = re.compile(r'\b(?:class|interface|enum|record|struct|object|trait|protocol|actor|union|module)\s+([A-Z_]\w*)')
JS_FUNC_RES = (
    re.compile(r'\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*\('),
    re.compile(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?'
               r'(?:function\b|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=;{]+)?=>)'),
    re.compile(r'^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?'
               r'([A-Za-z_$#][\w$]*)\s*(?:<[^>()]*>)?\s*\([^()]*\)\s*(?::\s*[^{;=()]+)?\{', re.M),
)
JS_IMPORT_RE = re.compile(r'''(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']''', re.M)
JS_REQUIRE_RE = re.compile(r'''\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)''')
PY_DEF_RE = re.compile(r'^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)', re.M)
PY_FROM_RE = re.compile(r'^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)', re.M)
PY_IMPORT_RE = re.compile(r'^[ \t]*import[ \t]+([^\n]+)', re.M)
GO_FUNC_RE = re.compile(r'^func[ \t]*(?:\([ \t]*\w*[ \t]*\*?[ \t]*(\w+)[^)]*\)[ \t]*)?(\w+)', re.M)
GO_TYPE_RE = re.compile(r'^type[ \t]+(\w+)[ \t]+(?:struct|interface)', re.M)
GO_IMPORT_BLOCK_RE = re.compile(r'^import[ \t]*\(([\s\S]*?)\)', re.M)
GO_IMPORT_ONE_RE = re.compile(r'^import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"', re.M)
RS_FN_RE = re.compile(r'\bfn\s+(\w+)')
RS_MOD_RE = re.compile(r'^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;', re.M)
RS_USE_RE = re.compile(r'\buse\s+((?:crate|super|self)(?:::\w+)*)')
JAVA_METHOD_RE = re.compile(
    r'^[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*'
    r'(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|strictfp|virtual|'
    r'override|async|sealed|extern|unsafe|new|partial|readonly|external|factory)\s+)*'
    r'(?:<[^>]+>\s+)?(?:[\w.$<>\[\],?]+\s+)?(\w+)\s*\([^;{}]*?\)\s*(?:throws\s+[\w.,\s]+)?(?:where\s+[^{]+)?(?:\{|=>)', re.M)
KT_FUN_RE = re.compile(r'\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(')
DEF_RE = re.compile(r'\bdef\s+(\w+)')
JVM_IMPORT_RE = re.compile(r'^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+(?:\.\*)?)', re.M)
SWIFT_FUNC_RE = re.compile(r'\bfunc\s+(\w+)')
RB_DEF_RE = re.compile(r'^[ \t]*def[ \t]+(?:self\.)?([\w?!=]+)', re.M)
RB_REQ_RE = re.compile(r'''\brequire(_relative)?\s*\(?\s*["']([^"'\n]+)["']''')
PHP_FUNC_RE = re.compile(r'\bfunction\s+&?\s*(\w+)\s*\(')
PHP_INC_RE = re.compile(r'''\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']([^"'\n]+)["']''')
PHP_USE_RE = re.compile(r'^[ \t]*use[ \t]+([\w\\]+)', re.M)
LUA_FUNC_RE = re.compile(r'\bfunction\s+([\w.:]+)\s*\(|([\w.]+)\s*=\s*function\s*\(')
LUA_REQ_RE = re.compile(r'''\brequire\s*\(?\s*["']([^"'\n]+)["']''')
DART_IMPORT_RE = re.compile(r'''^[ \t]*(?:import|export|part)[ \t]+["']([^"'\n]+)["']''', re.M)


def function_name(head):
    """Name of the C/C++ function whose body opens right after `head`, or None."""
    head = " ".join(head.split())
    m = INIT_LIST_RE.search(head)  # constructor initializer list: Foo::Foo(...) : a(1), b(2)
    if m:
        head = head[: m.start() + 1]
    head = TRAILING_QUALS_RE.sub("", head)
    if not head.endswith(")") or "=" in head.split("(", 1)[0]:
        return None
    depth = 0
    for i in range(len(head) - 1, -1, -1):  # walk back to the '(' matching the final ')'
        if head[i] == ")":
            depth += 1
        elif head[i] == "(":
            depth -= 1
            if depth == 0:
                break
    else:
        return None
    m = re.search(r'((?:[\w~]+::)*(?:operator\s*\S+?|operator\s*\(\s*\)|~?\w+))\s*$', head[:i])
    if not m:
        return None
    name = m.group(1).replace(" ", "")
    if name.rsplit("::", 1)[-1] in CONTROL or name[0].isdigit():
        return None
    return name


def find_c_functions(code):
    """Function definitions (bodies at namespace or class scope) in noise-stripped C/C++."""
    stack, names, seg = [], [], 0
    for m in BRACE_RE.finditer(code):
        i, c = m.start(), m.group()
        if c == "{":
            head = code[seg:i]
            if any(k in ("func", "block") for k in stack):
                kind = "block"
            else:
                tail = head.rsplit(":", 1)[-1] if re.search(r'\b(public|private|protected)\s*:', head) else head
                name = function_name(tail)
                if name:
                    kind = "func"
                    names.append(name)
                elif re.search(r'\bnamespace\b|\bextern\s*$', head) or re.search(r'\b(class|struct|union|enum)\b', head):
                    kind = "scope"
                else:
                    kind = "block"
            stack.append(kind)
            seg = i + 1
        elif c == "}":
            if stack:
                stack.pop()
            seg = i + 1
        else:
            seg = i + 1
    return names


def not_control(names):
    return [n for n in names if n and n not in CONTROL]


def py_names(chunk):
    chunk = chunk.strip().strip("()")
    out = []
    for part in chunk.replace("\n", " ").split(","):
        word = part.strip().split(" ")[0]
        if word and word != "*" and re.match(r'^\w+$', word):
            out.append(word)
    return out


def analyse(lang, ext, text, lines):
    """-> (noise-stripped code, function names, type names, raw import specs)"""
    if lang == "c":
        code = PREPROC_RE.sub(" ", C_NOISE.sub(" ", text))
        funcs = find_c_functions(code)
        classes = C_CLASS_RE.findall(text)
        if ext in (".m", ".mm"):
            funcs += OBJC_METHOD_RE.findall(code)
            classes += OBJC_CLASS_RE.findall(code)
        return code, funcs, classes, [m.group(1) for m in map(INCLUDE_RE.match, lines) if m]
    if lang == "js":
        code = JS_NOISE.sub(" ", text)
        funcs = []
        for rx in JS_FUNC_RES:
            funcs += not_control(rx.findall(code))
        return code, funcs, TYPE_RE.findall(code), JS_IMPORT_RE.findall(text) + JS_REQUIRE_RE.findall(text)
    if lang == "py":
        code = HASH_NOISE.sub(" ", text)
        imports = [("from", dots, mod, py_names(names)) for dots, mod, names in PY_FROM_RE.findall(code)]
        for chunk in PY_IMPORT_RE.findall(code):
            imports += [("import", p.strip().split(" ")[0]) for p in chunk.split(",") if p.strip()]
        return code, PY_DEF_RE.findall(code), TYPE_RE.findall(code), imports
    if lang == "go":
        code = C_NOISE.sub(" ", text)
        funcs = [f"{recv}.{name}" if recv else name for recv, name in GO_FUNC_RE.findall(code)]
        imports = GO_IMPORT_ONE_RE.findall(text)
        for block in GO_IMPORT_BLOCK_RE.findall(text):
            imports += re.findall(r'"([^"]+)"', block)
        return code, funcs, GO_TYPE_RE.findall(code), imports
    if lang == "rust":
        code = RUST_NOISE.sub(" ", text)
        imports = [("mod", m) for m in RS_MOD_RE.findall(code)] + [("use", u) for u in RS_USE_RE.findall(code)]
        return code, RS_FN_RE.findall(code), TYPE_RE.findall(code), imports
    if lang == "jvm":
        code = C_NOISE.sub(" ", text)
        if ext in (".kt", ".kts"):
            funcs = KT_FUN_RE.findall(code)
        elif ext == ".scala":
            funcs = DEF_RE.findall(code)
        else:
            funcs = not_control(JAVA_METHOD_RE.findall(code))
        return code, funcs, TYPE_RE.findall(code), JVM_IMPORT_RE.findall(code)
    if lang in ("cs", "dart"):
        code = C_NOISE.sub(" ", text)
        imports = DART_IMPORT_RE.findall(text) if lang == "dart" else []
        return code, not_control(JAVA_METHOD_RE.findall(code)), TYPE_RE.findall(code), imports
    if lang == "swift":
        code = C_NOISE.sub(" ", text)
        return code, SWIFT_FUNC_RE.findall(code), TYPE_RE.findall(code), []
    if lang == "ruby":
        code = HASH_NOISE.sub(" ", text)
        return code, RB_DEF_RE.findall(code), TYPE_RE.findall(code), RB_REQ_RE.findall(text)
    if lang == "php":
        code = PHP_NOISE.sub(" ", text)
        imports = [("inc", s) for s in PHP_INC_RE.findall(text)] + [("use", u) for u in PHP_USE_RE.findall(code)]
        return code, PHP_FUNC_RE.findall(code), TYPE_RE.findall(code), imports
    if lang == "lua":
        code = LUA_NOISE.sub(" ", text)
        funcs = [a or b for a, b in LUA_FUNC_RE.findall(code)]
        return code, funcs, [], LUA_REQ_RE.findall(text)
    return text, [], [], []


_cache = {}  # full path -> ((mtime_ns, size), parsed file)


def parse_file(full, lang, ext, st):
    key = (st.st_mtime_ns, st.st_size)
    hit = _cache.get(full)
    if hit and hit[0] == key:
        return hit[1]
    with open(full, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    code, functions, classes, imports = analyse(lang, ext, text, lines)
    parsed = {
        "loc": len(lines),
        "sha": hashlib.sha1(raw).hexdigest(),
        "functions": functions,
        "classes": classes,
        "imports": imports,
        "words": Counter(WORD_RE.findall(code)),
        "preview": "\n".join(lines[:PREVIEW_LINES]),
    }
    _cache[full] = (key, parsed)
    return parsed


# ---------- file listing ----------
def git_files(root):
    git = shutil.which("git") or next((g for g in ("/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git") if os.path.exists(g)), None)
    if not git:
        return None
    try:
        out = subprocess.run([git, "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                             capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return [p for p in out.stdout.decode("utf-8", "replace").split("\0") if p]


def walk_files(root):
    rels = []
    for dirpath, dirnames, names in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in WALK_IGNORE)
        base = os.path.relpath(dirpath, root)
        for name in names:
            rels.append(name if base == "." else posixpath.join(base.replace(os.sep, "/"), name))
            if len(rels) > MAX_FILES * 20:
                return rels
    return rels


def list_files(root):
    rels = git_files(root)
    via_git = rels is not None
    if rels is None:
        rels = walk_files(root)
    files, gomods = {}, {}
    for rel in sorted(rels):
        parts = rel.split("/")
        if any(p in HARD_IGNORE for p in parts[:-1]):
            continue
        name = parts[-1]
        if name == "go.mod":
            gomods[posixpath.dirname(rel)] = os.path.join(root, rel)
            continue
        ext = posixpath.splitext(name)[1]
        lang = EXT_LANG.get(ext) or EXT_LANG.get(ext.lower())
        if not lang or name.endswith(SKIP_SUFFIXES):
            continue
        full = os.path.join(root, rel)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_FILE_BYTES:
            continue
        files[rel] = (full, lang, ext, st)
    truncated = len(files) > MAX_FILES
    if truncated:
        files = dict(list(files.items())[:MAX_FILES])
    return files, gomods, truncated, via_git


# ---------- modules & import resolution ----------
def module_id(rel, lang):
    if lang == "go":  # a Go package is a directory
        d = posixpath.dirname(rel)
        return d if d else "(root)"
    return posixpath.splitext(rel)[0]  # foo.h + foo.cpp share a module


def display_name(mod, lang, root_name):
    if mod == "(root)":
        return root_name
    base = posixpath.basename(mod)
    parent = posixpath.basename(posixpath.dirname(mod))
    if lang != "go" and base in GENERIC_STEMS and parent:
        return f"{parent}/{base}"
    return base


def assign_groups(mods):
    """Colour groups: every folder is a group until there are too many; then the deepest
    folders fold into their parents (so deep Java/Kotlin package trees still split nicely)."""
    groups = {m: ("" if m == "(root)" else posixpath.dirname(m)) for m in mods}
    while True:
        names = set(groups.values())
        if len(names) <= MAX_GROUPS:
            break
        deepest = max(g.count("/") + 1 if g else 0 for g in names)
        if deepest == 0:
            break
        for m, g in groups.items():
            if g and g.count("/") + 1 == deepest:
                groups[m] = posixpath.dirname(g)
    return {m: g or "(root)" for m, g in groups.items()}


class Resolver:
    def __init__(self, files, gomods):
        self.rels = set(files)
        self.mod_of = {rel: module_id(rel, files[rel][1]) for rel in files}
        self.by_base, self.by_stem = defaultdict(list), defaultdict(list)
        self.go_dirs = defaultdict(list)
        for rel, (_, lang, _, _) in files.items():
            base = posixpath.basename(rel)
            self.by_base[base].append(rel)
            self.by_stem[posixpath.splitext(base)[0]].append(rel)
            if lang == "go":
                self.go_dirs[posixpath.dirname(rel)].append(rel)
        self.jvm_rels = [r for r in files if files[r][1] == "jvm"]
        self.go_mods = []
        for d, full in gomods.items():
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    m = re.search(r'^module\s+(\S+)', f.read(), re.M)
                if m:
                    self.go_mods.append((d, m.group(1)))
            except OSError:
                pass
        self.go_mods.sort(key=lambda x: -len(x[1]))
        self._build_python_index([r for r in files if files[r][1] == "py"])

    def _build_python_index(self, pyfiles):
        packages = {posixpath.dirname(r) for r in pyfiles if posixpath.basename(r) in ("__init__.py", "__init__.pyi")}
        self.py_index, self.py_pkg = {}, {}
        for r in pyfiles:
            dirs = r.split("/")[:-1]
            k = len(dirs)
            while k > 0 and "/".join(dirs[:k]) in packages:  # climb to the first folder that isn't a package
                k -= 1
            self.py_pkg[r] = ".".join(dirs[k:])
            for start in (k, 0):
                parts = posixpath.splitext(r)[0].split("/")[start:]
                if parts and parts[-1] == "__init__":
                    parts = parts[:-1]
                if parts:
                    self.py_index.setdefault(".".join(parts), r)

    def best(self, cands, rel):
        """The candidate sharing the longest folder prefix with `rel`."""
        if len(cands) <= 1:
            return list(cands)
        here = rel.split("/")

        def score(c):
            common = 0
            for a, b in zip(here, c.split("/")):
                if a != b:
                    break
                common += 1
            return (-common, c.count("/"), c)
        return [min(cands, key=score)]

    def suffix(self, path, exts):
        out = []
        for r in self.by_stem.get(posixpath.basename(path), ()):
            base, ext = posixpath.splitext(r)
            if ext in exts and (base == path or base.endswith("/" + path)):
                out.append(r)
        return out

    def resolve(self, lang, rel, imp):
        fn = getattr(self, "r_" + lang, None)
        return [self.mod_of[r] for r in (fn(rel, imp) if fn else ()) if r in self.mod_of]

    def r_c(self, rel, spec):
        here = posixpath.dirname(rel)
        for cand in (posixpath.normpath(posixpath.join(here, spec)), posixpath.normpath(spec)):
            if cand in self.rels:
                return [cand]
        cands = [r for r in self.by_base.get(posixpath.basename(spec), ()) if r.endswith("/" + spec)]
        return self.best(cands, rel)

    def r_js(self, rel, spec):
        spec = spec.split("?")[0].split("#")[0]
        if not spec:
            return []
        # aliases (@/x, ~/x) and baseUrl imports are tried against each enclosing src/ folder
        src_dirs = []
        d = posixpath.dirname(rel)
        while d:
            if posixpath.basename(d) == "src":
                src_dirs.append(d)
            d = posixpath.dirname(d)
        if spec.startswith("."):
            bases = [posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))]
        elif spec[:2] in ("@/", "~/"):
            bases = [posixpath.join(s, spec[2:]) for s in src_dirs] + ["src/" + spec[2:], spec[2:]]
        elif spec.startswith("/"):
            bases = [spec.lstrip("/")]
        else:  # baseUrl-style; real packages simply won't match a file
            bases = [posixpath.join(s, spec) for s in src_dirs] + [spec, "src/" + spec]
        for b in bases:
            tries = [b]
            if b.endswith((".js", ".jsx", ".mjs", ".cjs")):  # TS ESM writes ./foo.js for ./foo.ts
                stem = posixpath.splitext(b)[0]
                tries += [stem + e for e in (".ts", ".tsx", ".mts", ".cts")]
            tries += [b + e for e in JS_EXTS] + [b + "/index" + e for e in JS_EXTS]
            for t in tries:
                if t in self.rels:
                    return [t]
        return []

    def r_py(self, rel, imp):
        idx = self.py_index
        if imp[0] == "import":
            parts = imp[1].split(".")
            for n in range(len(parts), 0, -1):
                r = idx.get(".".join(parts[:n]))
                if r:
                    return [r]
            return []
        _, dots, mod, names = imp
        if dots:
            base = self.py_pkg.get(rel, "")
            parts = base.split(".") if base else []
            up = len(dots) - 1
            if up:
                parts = parts[:-up] if up < len(parts) else []
            full = parts + (mod.split(".") if mod else [])
        else:
            full = mod.split(".")
        prefix = ".".join(full)
        out = [idx[k] for k in ((prefix + "." + nm) if prefix else nm for nm in names) if k in idx]
        if not out:
            for n in range(len(full), 0, -1):
                r = idx.get(".".join(full[:n]))
                if r:
                    return [r]
        return out

    def r_go(self, rel, spec):
        for moddir, modpath in self.go_mods:
            if spec == modpath or spec.startswith(modpath + "/"):
                sub = spec[len(modpath):].lstrip("/")
                d = posixpath.normpath(posixpath.join(moddir, sub)) if (moddir or sub) else ""
                d = "" if d == "." else d
                if self.go_dirs.get(d):
                    return [self.go_dirs[d][0]]
        return []

    def _crate_root(self, d):
        while True:
            if posixpath.join(d, "lib.rs") in self.rels or posixpath.join(d, "main.rs") in self.rels:
                return d
            if not d:
                return "src" if any(r.startswith("src/") for r in self.rels) else ""
            d = posixpath.dirname(d)

    def r_rust(self, rel, imp):
        kind, path = imp
        d = posixpath.dirname(rel)
        stem = posixpath.splitext(posixpath.basename(rel))[0]
        cur = d if stem in ("mod", "lib", "main") else posixpath.join(d, stem)  # folder holding this module's children

        def find(base, segs):
            for n in range(len(segs), 0, -1):
                p = posixpath.join(base, *segs[:n])
                for c in (p + ".rs", p + "/mod.rs"):
                    if c in self.rels:
                        return [c]
            return []
        if kind == "mod":
            return find(cur, [path])
        segs = path.split("::")
        if segs[0] == "crate":
            base, segs = self._crate_root(d), segs[1:]
        else:
            base = cur
            while segs and segs[0] in ("self", "super"):
                if segs[0] == "super":
                    base = posixpath.dirname(base)
                segs = segs[1:]
        return find(base, segs) if segs else []

    def r_jvm(self, rel, spec):
        exts = LANGS["jvm"][1]
        if spec.endswith(".*"):
            pkg = spec[:-2].replace(".", "/")
            return [r for r in self.jvm_rels
                    if posixpath.dirname(r) == pkg or posixpath.dirname(r).endswith("/" + pkg)][:40]
        parts = spec.split(".")
        for n in range(len(parts), 1, -1):  # a.b.C, or a.b.C.member for static imports
            hit = self.suffix("/".join(parts[:n]), exts)
            if hit:
                return self.best(hit, rel)
        return []

    def r_dart(self, rel, spec):
        if spec.startswith("dart:"):
            return []
        if spec.startswith("package:"):
            rest = spec.split("/", 1)[1] if "/" in spec else ""
            cand = "lib/" + rest
            return [cand] if cand in self.rels else self.best(self.suffix(posixpath.splitext(rest)[0], (".dart",)), rel)
        p = posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))
        return [p] if p in self.rels else []

    def r_ruby(self, rel, imp):
        relative, spec = imp
        spec = spec[:-3] if spec.endswith(".rb") else spec
        if relative:
            p = posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec)) + ".rb"
            return [p] if p in self.rels else []
        return self.best(self.suffix(spec, (".rb",)), rel)

    def r_php(self, rel, imp):
        kind, spec = imp
        if kind == "inc":
            p = posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec.lstrip("/")))
            if p in self.rels:
                return [p]
            return self.best(self.suffix(posixpath.splitext(spec.lstrip("./"))[0], (".php",)), rel)
        parts = [p for p in spec.split("\\") if p]
        for n in range(len(parts), 0, -1):
            hit = self.suffix("/".join(parts[-n:]), (".php",))
            if hit and (n > 1 or len(hit) == 1):
                return self.best(hit, rel)
        return []

    def r_lua(self, rel, spec):
        p = spec.replace(".", "/")
        return self.best(self.suffix(p, (".lua",)) or self.suffix(p + "/init", (".lua",)), rel)


def scan(root):
    """One node per module; an edge A->B when A imports/includes B (or uses a type only B declares)."""
    t0 = time.time()
    files, gomods, truncated, via_git = list_files(root)
    root_name = os.path.basename(root.rstrip(os.sep)) or root
    res = Resolver(files, gomods)
    nodes, words, edges, langs = {}, defaultdict(Counter), defaultdict(int), Counter()

    for rel in sorted(files):
        full, lang, ext, st = files[rel]
        pf = parse_file(full, lang, ext, st)
        mod = res.mod_of[rel]
        langs[LANGS[lang][0]] += 1
        node = nodes.get(mod)
        if node is None:
            node = nodes[mod] = {
                "id": mod, "name": display_name(mod, lang, root_name), "group": "",
                "lang": LANGS[lang][0], "_lang": lang,
                "files": [], "loc": 0, "funcs": 0, "functions": [], "classes": [],
                "preview": "", "previewFile": "", "hash": "",
            }
        node["files"].append(rel)
        node["loc"] += pf["loc"]
        node["hash"] = hashlib.sha1((node["hash"] + rel + pf["sha"]).encode()).hexdigest()[:12]
        node["funcs"] += len(pf["functions"])
        node["functions"].extend(pf["functions"])
        words[mod].update(pf["words"])
        for c in pf["classes"]:
            if c not in node["classes"]:
                node["classes"].append(c)
        prefer = rel.endswith(C_HEADERS) if lang == "c" else (lang == "go" and not rel.endswith("_test.go"))
        if not node["preview"] or (prefer and not node.get("_preferred")):
            node["preview"], node["previewFile"], node["_preferred"] = pf["preview"], rel, prefer
        for imp in pf["imports"]:
            for target in res.resolve(lang, rel, imp):
                if target != mod:
                    edges[(mod, target)] += 1

    refs = {}
    for (s, t) in edges:
        # references: how often the importer mentions the imported module's types / name
        names = set(nodes[t]["classes"]) | {nodes[t]["name"], posixpath.basename(t)}
        refs[(s, t)] = max(1, sum(words[s][w] for w in names))

    # same-package type references (Java/Kotlin, C#, Swift, Dart need no import for these)
    declared = defaultdict(lambda: defaultdict(set))
    for mod, n in nodes.items():
        if n["_lang"] in SYMBOL_LANGS:
            for c in n["classes"]:
                if len(c) >= 3 and c[0].isupper() and c not in SYMBOL_STOP:
                    declared[n["_lang"]][c].add(mod)
    for lang, names in declared.items():
        unique = {c: next(iter(ms)) for c, ms in names.items() if len(ms) == 1}
        for mod, n in nodes.items():
            if n["_lang"] != lang:
                continue
            w = words[mod]
            for c in w.keys() & unique.keys():
                t = unique[c]
                if t != mod and (mod, t) not in edges:
                    refs[(mod, t)] = refs.get((mod, t), 0) + w[c]

    for mod, g in assign_groups(list(nodes)).items():
        nodes[mod]["group"] = g
    for n in nodes.values():
        n["classes"] = n["classes"][:24]
        n["functions"] = n["functions"][:MAX_FUNC_NAMES]
        n.pop("_lang", None)
        n.pop("_preferred", None)

    links = [{"source": s, "target": t, "count": edges.get((s, t), 0), "refs": r,
              "via": "import" if (s, t) in edges else "symbol"} for (s, t), r in sorted(refs.items())]
    return {
        "root": root,
        "name": root_name,
        "scannedAt": time.time(),
        "scanMs": round((time.time() - t0) * 1000),
        "viaGit": via_git,
        "truncated": truncated,
        "fileCount": len(files),
        "languages": dict(langs.most_common()),
        "nodes": sorted(nodes.values(), key=lambda n: n["id"]),
        "links": links,
    }


# ---------- recent repositories (the only thing written to disk) ----------
if sys.platform == "darwin":
    CONFIG_DIR = os.path.expanduser("~/Library/Application Support/Code Room")
else:
    CONFIG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "coderoom")
RECENT_FILE = os.path.join(CONFIG_DIR, "recent.json")
_recent_lock = threading.Lock()


def load_recent():
    try:
        with open(RECENT_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return [r for r in data if isinstance(r, dict) and isinstance(r.get("path"), str)]
    except (OSError, ValueError):
        return []


def remember(graph):
    entry = {
        "path": graph["root"], "name": graph["name"], "opened": time.time(),
        "modules": len(graph["nodes"]), "languages": list(graph["languages"])[:3],
    }
    with _recent_lock:
        recent = [entry] + [r for r in load_recent() if r["path"] != graph["root"]]
        try:
            os.makedirs(CONFIG_DIR, exist_ok=True)
            tmp = RECENT_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(recent[:MAX_RECENT], f, indent=1)
            os.replace(tmp, RECENT_FILE)
        except OSError:
            pass


def list_dir(path):
    entries = []
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    if e.is_dir():
                        entries.append({"name": e.name, "path": e.path,
                                        "git": os.path.exists(os.path.join(e.path, ".git"))})
                except OSError:
                    pass
    except OSError as err:
        raise ValueError(str(err))
    entries.sort(key=lambda e: e["name"].lower())
    parent = os.path.dirname(path)
    return {"path": path, "parent": parent if parent != path else None,
            "isRepo": os.path.exists(os.path.join(path, ".git")), "dirs": entries[:800]}


# ---------- HTTP ----------
SCAN_LOCK = threading.Lock()


def clean_path(p):
    return os.path.realpath(os.path.expanduser(p.strip()))


SAMPLE_NAME = re.compile(r"[A-Za-z0-9_-]+\.(?:m4a|flac|json|mod|xm|mp3)")
SAMPLE_TYPES = {".m4a": "audio/mp4", ".flac": "audio/flac", ".json": "application/json", ".mod": "application/octet-stream",
                ".xm": "application/octet-stream", ".mp3": "audio/mpeg"}

# Scene classics (keygen / cracktro tunes) whose license lets them be passed on only as the original,
# unbundled file: they're not shipped with Code Room. The first time the radio picks one, it's downloaded
# from The Mod Archive into the user's cache, the same as saving it from the site. Only the module ids
# listed in music/playlist.json are ever fetched.
if sys.platform == "darwin":
    MODULE_CACHE = os.path.expanduser("~/Library/Caches/Code Room/modules")
else:
    MODULE_CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "coderoom", "modules")
_module_lock = threading.Lock()


def remote_ids():
    try:
        with open(os.path.join(HERE, "music", "playlist.json"), encoding="utf-8") as f:
            return {int(e["remote"]) for e in json.load(f) if e.get("remote")}
    except (OSError, ValueError, KeyError, TypeError):
        return set()


def fetch_module(mid):
    path = os.path.join(MODULE_CACHE, f"{mid}.bin")
    with _module_lock:
        if os.path.isfile(path):
            return path
        req = urllib.request.Request(f"https://api.modarchive.org/downloads.php?moduleid={mid}", headers={"User-Agent": "CodeRoom/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read(4 * 1024 * 1024 + 1)
        is_xm = data[:17] == b"Extended Module: "
        is_mod = data[1080:1084] in (b"M.K.", b"M!K!", b"4CHN", b"FLT4")
        if len(data) > 4 * 1024 * 1024 or not (is_xm or is_mod):
            raise ValueError("not a module")
        os.makedirs(MODULE_CACHE, exist_ok=True)
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "CodeRoom"

    def _send(self, code, body, ctype, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        if cache != "no-store":
            self.send_header("Accept-Ranges", "bytes")
            if getattr(self, "last_modified", None): self.send_header("Last-Modified", self.last_modified)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, separators=(",", ":")).encode(), "application/json")

    def do_GET(self):
        # only answer to our own origin (blocks DNS-rebinding pages from reading local code)
        if self.headers.get("Host") not in self.server.allowed_hosts:
            return self._send(403, b"forbidden", "text/plain")
        url = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if url.path in ("/sound.js", "/scanner.js"):
            with open(os.path.join(HERE, url.path[1:]), "rb") as f:
                return self._send(200, f.read(), "text/javascript; charset=utf-8")
        remote = re.fullmatch(r"/music/remote/(\d{1,7})", url.path)
        if remote:
            mid = int(remote.group(1))
            if mid not in remote_ids():
                return self._send(404, b"not found", "text/plain")
            try:
                path = fetch_module(mid)
            except Exception as err:  # offline, or the archive is down: the radio just picks something else
                return self._send(502, f"can't fetch module {mid}: {err}".encode(), "text/plain")
            with open(path, "rb") as f:
                return self._send(200, f.read(), "application/octet-stream", "no-cache")
        if url.path.startswith(("/samples/", "/music/")):
            # the bundled sample pack and music: plain file names only, never a path
            folder, name = url.path[1:].split("/", 1)
            ctype = SAMPLE_TYPES.get(os.path.splitext(name)[1])
            path = os.path.join(HERE, folder, name)
            if not SAMPLE_NAME.fullmatch(name) or not ctype or not os.path.isfile(path):
                return self._send(404, b"not found", "text/plain")
            # revalidate by modification time, so a rebuilt sample is never served stale from a cache
            mtime = email.utils.formatdate(os.path.getmtime(path), usegmt=True)
            if self.headers.get("If-Modified-Since") == mtime and not self.headers.get("Range"):
                self.send_response(304); self.send_header("Last-Modified", mtime); self.end_headers(); return
            with open(path, "rb") as f:
                data = f.read()
            self.last_modified = mtime
            rng = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
            if not rng or not (rng.group(1) or rng.group(2)):
                return self._send(200, data, ctype, "no-cache")
            # byte ranges: WebKit's media engine streams and seeks audio this way
            n = len(data)
            if rng.group(1):
                start, end = int(rng.group(1)), min(n - 1, int(rng.group(2) or n - 1))
            else:
                start, end = max(0, n - int(rng.group(2))), n - 1
            if start >= n or start > end:
                self.send_response(416); self.send_header("Content-Range", f"bytes */{n}"); self.end_headers(); return
            body = data[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{n}")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Last-Modified", mtime)
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/api/graph":
            root = qs.get("root") or self.server.default_root
            if not root:
                return self._json(400, {"error": "No repository selected yet."})
            root = clean_path(root)
            if not os.path.isdir(root):
                return self._json(404, {"error": f"Folder not found: {root}"})
            with SCAN_LOCK:
                graph = scan(root)
            remember(graph)
            self.server.default_root = root
            return self._json(200, graph)
        if url.path == "/api/recent":
            recent = [r for r in load_recent() if os.path.isdir(r["path"])]
            return self._json(200, {"recent": recent, "default": self.server.default_root,
                                    "home": os.path.expanduser("~"),
                                    "languages": [name for name, _ in LANGS.values()]})
        if url.path == "/api/listdir":
            try:
                return self._json(200, list_dir(clean_path(qs.get("path") or "~")))
            except ValueError as err:
                return self._json(400, {"error": str(err)})
        return self._send(404, b"not found", "text/plain")

    def log_message(self, fmt, *args):
        sys.stderr.write("[coderoom] " + (fmt % args) + "\n")


def watch_parent():
    """Exit when the app that launched us goes away (we get re-parented)."""
    parent = os.getppid()
    while True:
        time.sleep(2)
        if os.getppid() != parent:
            os._exit(0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", help="repository / source folder to open first (read-only)")
    ap.add_argument("--port", type=int, default=8765, help="0 picks any free port")
    ap.add_argument("--open", action="store_true", help="open the page in the default browser")
    ap.add_argument("--exit-with-parent", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    default_root = None
    if args.src:
        default_root = clean_path(args.src)
        if not os.path.isdir(default_root):
            raise SystemExit(f"folder not found: {default_root}")
    else:
        default_root = next((r["path"] for r in load_recent() if os.path.isdir(r["path"])), None)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    httpd.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    httpd.default_root = default_root
    if args.exit_with_parent:
        threading.Thread(target=watch_parent, daemon=True).start()
    if default_root:  # warm the parse cache so the first page load is quick
        def warm():
            with SCAN_LOCK:
                scan(default_root)
        threading.Thread(target=warm, daemon=True).start()

    url = f"http://127.0.0.1:{port}/"
    print(f"CODEROOM_READY {url}", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
