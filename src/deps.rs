//! Deterministic, offline static dependency approximation. Dynamic dispatch,
//! indirect calls, macros and generated code are unresolved, never inferred.

use crate::file_security::Root;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 512 * 1024;
/// Maximum serialized index size (64 MiB), shared by reads/parsing and writes.
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CALLS: usize = 200;
const NOTE: &str = "静的近似 (static approximation): dynamic dispatch・間接呼び出し・マクロ生成・生成コードは unresolved / unknown。外部パッケージ、曖昧な名前、lexer で確定できない参照も unresolved。名前一致による潜在的な影響を含み、字句スコープ・型の binding は unknown。";
const SKIP_DIRS: &[&str] = &[
    ".git",
    "target",
    "node_modules",
    "dist",
    ".local",
    ".serde",
    ".serena",
    ".playwright-cli",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    "coverage",
];

#[derive(Clone, Debug, PartialEq, Eq)]
struct ImportRef {
    kind: String,
    spec: String,
    members: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    hash: String,
    size: u64,
    // Nanoseconds since epoch: seconds alone miss edits made within one second.
    mtime: u64,
    lang: String,
    imports: Vec<String>,
    symbols: Vec<String>,
    calls: Vec<String>,
    static_calls: Vec<String>,
    import_specs: Vec<ImportRef>,
    tests: bool,
    truncated: bool,
    unknown: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Index {
    root: String,
    built_at_unix: u64,
    go_module: String,
    files: BTreeMap<String, Entry>,
    unknown: Vec<String>,
}

#[derive(Default)]
struct Scan {
    files: BTreeMap<String, (u64, u64)>,
    unknown: Vec<String>,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sorted(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn relative(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn normal_path(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(s) => out.push(s),
            Component::CurDir => (),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(out)
}

fn repository_root(root: Option<&str>) -> Result<PathBuf> {
    let cwd = std::env::current_dir()?;
    let path = if let Some(root) = root {
        PathBuf::from(root)
    } else {
        cwd.ancestors()
            .find(|p| p.join(".git").exists())
            .unwrap_or(&cwd)
            .to_path_buf()
    };
    let path = fs::canonicalize(path).context("unknown: repository root is unavailable")?;
    anyhow::ensure!(path.is_dir(), "unknown: repository root is not a directory");
    anyhow::ensure!(
        path.to_str().is_some(),
        "unknown: repository root is not UTF-8"
    );
    Ok(path)
}

fn index_path(root: &Path, home: &Path) -> PathBuf {
    home.join("rdsh-index").join(format!(
        "{}.json",
        digest(root.to_string_lossy().as_bytes())
    ))
}

fn mtime(meta: &fs::Metadata) -> Option<u64> {
    let nanos = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    u64::try_from(nanos).ok()
}

#[derive(Clone)]
struct IgnoreRule {
    base: String,
    pattern: String,
    negated: bool,
    directory: bool,
    anchored: bool,
}

// Deliberately small gitignore subset: *, **, ?, root/nested rules and !.
fn wildcard(pattern: &[u8], text: &[u8]) -> bool {
    let mut row = vec![false; text.len() + 1];
    row[0] = true;
    let mut i = 0;
    while i < pattern.len() {
        let mut next = vec![false; row.len()];
        if pattern[i] == b'*' {
            let double = pattern.get(i + 1) == Some(&b'*');
            if double {
                i += 1;
            }
            if double && pattern.get(i + 1) == Some(&b'/') {
                // Zero directories, or any prefix ending at a slash.
                next.clone_from(&row);
                let mut reachable = false;
                for j in 1..next.len() {
                    reachable |= row[j - 1];
                    next[j] |= reachable && text[j - 1] == b'/';
                }
                row = next;
                i += 2;
                continue;
            }
            next[0] = row[0];
            for j in 1..next.len() {
                next[j] = row[j] || (next[j - 1] && (double || text[j - 1] != b'/'));
            }
        } else {
            for j in 1..next.len() {
                next[j] = row[j - 1]
                    && (pattern[i] == text[j - 1] || (pattern[i] == b'?' && text[j - 1] != b'/'));
            }
        }
        row = next;
        i += 1;
    }
    row[text.len()]
}

fn read_config(
    root: &Path,
    reader: Option<&Root>,
    path: &Path,
    unknown: &mut Vec<String>,
) -> Option<String> {
    if fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return None;
    }
    let mut source = String::new();
    if reader
        .and_then(|r| r.open(path))
        .is_some_and(|file| file.take(MAX_BYTES).read_to_string(&mut source).is_ok())
    {
        Some(source)
    } else {
        unknown.push(format!(
            "unknown: {} read failed",
            relative(path.strip_prefix(root).unwrap_or(path))
        ));
        None
    }
}

fn ignore_rules(
    root: &Path,
    dir: &Path,
    reader: Option<&Root>,
    unknown: &mut Vec<String>,
) -> Vec<IgnoreRule> {
    let Some(source) = read_config(root, reader, &dir.join(".gitignore"), unknown) else {
        return Vec::new();
    };
    source
        .lines()
        .filter_map(|line| {
            let mut line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let negated = line.starts_with('!');
            if negated {
                line = &line[1..];
            }
            let anchored = line.starts_with('/');
            let directory = line.ends_with('/');
            let pattern = line.trim_matches('/').to_string();
            (!pattern.is_empty()).then(|| IgnoreRule {
                base: relative(dir.strip_prefix(root).unwrap_or(dir)),
                pattern,
                negated,
                directory,
                anchored,
            })
        })
        .collect()
}

fn ignored(path: &str, directory: bool, rules: &[IgnoreRule]) -> bool {
    let mut result = false;
    for rule in rules {
        let local = if rule.base.is_empty() {
            path
        } else if let Some(rest) = path.strip_prefix(&format!("{}/", rule.base)) {
            rest
        } else {
            continue;
        };
        let parts: Vec<_> = local.split('/').collect();
        let matched = if rule.anchored || rule.pattern.contains('/') {
            (1..=parts.len()).any(|n| {
                (!rule.directory || n < parts.len() || directory)
                    && wildcard(rule.pattern.as_bytes(), parts[..n].join("/").as_bytes())
            })
        } else {
            parts.iter().enumerate().any(|(i, part)| {
                (!rule.directory || i + 1 < parts.len() || directory)
                    && wildcard(rule.pattern.as_bytes(), part.as_bytes())
            })
        };
        if matched {
            result = !rule.negated;
        }
    }
    result
}

fn language(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()? {
        "rs" => Some("rs"),
        "js" | "mjs" | "cjs" | "jsx" => Some("js"),
        "ts" | "tsx" => Some("ts"),
        "py" => Some("py"),
        "go" => Some("go"),
        _ => None,
    }
}

fn scan(root: &Path, reader: Option<&Root>) -> Scan {
    fn visit(
        root: &Path,
        dir: &Path,
        reader: Option<&Root>,
        rules: &[IgnoreRule],
        result: &mut Scan,
    ) {
        let mut rules = rules.to_vec();
        rules.extend(ignore_rules(root, dir, reader, &mut result.unknown));
        let Ok(read) = fs::read_dir(dir) else {
            result.unknown.push(format!(
                "unknown: unreadable directory {}",
                relative(dir.strip_prefix(root).unwrap_or(dir))
            ));
            return;
        };
        let mut children = Vec::new();
        for child in read {
            match child {
                Ok(child) => children.push(child),
                Err(_) => result
                    .unknown
                    .push("unknown: unreadable directory entry".into()),
            }
        }
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let path = child.path();
            let rel_path = path.strip_prefix(root).unwrap_or(&path);
            if rel_path.to_str().is_none() {
                result
                    .unknown
                    .push("unknown: non-UTF-8 path skipped".into());
                continue;
            }
            let rel = relative(rel_path);
            let Ok(kind) = child.file_type() else {
                result.unknown.push(format!("unknown: file type {rel}"));
                continue;
            };
            if kind.is_symlink() {
                if language(&path).is_some() {
                    result
                        .unknown
                        .push(format!("unknown: symlink skipped {rel}"));
                }
                continue;
            }
            if kind.is_dir() {
                if SKIP_DIRS.contains(&child.file_name().to_string_lossy().as_ref())
                    || ignored(&rel, true, &rules)
                {
                    continue;
                }
                visit(root, &path, reader, &rules, result);
            } else if kind.is_file() && language(&path).is_some() && !ignored(&rel, false, &rules) {
                if result.files.len() == MAX_FILES {
                    result
                        .unknown
                        .push("unknown: file limit 20000 exceeded (truncated scan)".into());
                    return;
                }
                match child.metadata() {
                    Ok(meta) => {
                        let modified = mtime(&meta).unwrap_or_else(|| {
                            result.unknown.push(format!("unknown: mtime {rel}"));
                            0
                        });
                        result.files.insert(rel, (meta.len(), modified));
                    }
                    Err(_) => result.unknown.push(format!("unknown: metadata {rel}")),
                }
            }
            if result.files.len() == MAX_FILES && !result.unknown.is_empty() {
                // Continue only if the cap has not actually been exceeded.
                if result.unknown.iter().any(|s| s.contains("file limit")) {
                    return;
                }
            }
        }
    }
    let mut result = Scan::default();
    visit(root, root, reader, &[], &mut result);
    result.unknown = sorted(result.unknown);
    result
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    Word,
    Literal,
    Punct,
    Newline,
}

#[derive(Clone, Debug)]
struct Token {
    text: String,
    kind: Kind,
    dynamic: bool,
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte >= 128
}

fn lex(source: &str, lang: &str) -> (Vec<Token>, Vec<String>) {
    let bytes = source.as_bytes();
    let mut tokens: Vec<Token> = Vec::new();
    let mut unknown = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            tokens.push(Token {
                text: "\n".into(),
                kind: Kind::Newline,
                dynamic: false,
            });
            i += 1;
            continue;
        }
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if (lang == "py" && bytes[i] == b'#') || (lang != "py" && bytes[i..].starts_with(b"//")) {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if lang != "py" && bytes[i..].starts_with(b"/*") {
            i += 2;
            let mut level = 1;
            while i < bytes.len() && level > 0 {
                if lang == "rs" && bytes[i..].starts_with(b"/*") {
                    level += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    level -= 1;
                    i += 2;
                } else {
                    if bytes[i] == b'\n' {
                        tokens.push(Token {
                            text: "\n".into(),
                            kind: Kind::Newline,
                            dynamic: false,
                        });
                    }
                    i += 1;
                }
            }
            if level != 0 {
                unknown.push("unknown: unterminated comment".into());
            }
            continue;
        }
        // Rust raw/byte raw strings; treating their contents as code is unsafe.
        if lang == "rs"
            && (bytes[i..].starts_with(b"r\"")
                || bytes[i..].starts_with(b"r#")
                || bytes[i..].starts_with(b"br\"")
                || bytes[i..].starts_with(b"br#"))
        {
            let mut quote = i + if bytes[i] == b'b' { 2 } else { 1 };
            while bytes.get(quote) == Some(&b'#') {
                quote += 1;
            }
            if bytes.get(quote) == Some(&b'"') {
                let hashes = quote - i - if bytes[i] == b'b' { 2 } else { 1 };
                let start = quote + 1;
                i = start;
                while i < bytes.len()
                    && !(bytes[i] == b'"'
                        && bytes
                            .get(i + 1..i + 1 + hashes)
                            .is_some_and(|b| b.iter().all(|c| *c == b'#')))
                {
                    i += 1;
                }
                let text = source[start..i].to_string();
                if i == bytes.len() {
                    unknown.push("unknown: unterminated raw string".into());
                } else {
                    i += 1 + hashes;
                }
                tokens.push(Token {
                    text,
                    kind: Kind::Literal,
                    dynamic: false,
                });
                continue;
            }
        }
        let quote = bytes[i];
        let rust_lifetime =
            lang == "rs" && quote == b'\'' && bytes.get(i + 1).is_some_and(|c| is_word(*c)) && {
                let mut end = i + 1;
                while end < bytes.len() && is_word(bytes[end]) {
                    end += 1;
                }
                bytes.get(end) != Some(&b'\'')
            };
        if (quote == b'"'
            || quote == b'\''
            || (quote == b'`' && matches!(lang, "js" | "ts" | "go")))
            && !rust_lifetime
        {
            let triple = lang == "py" && bytes.get(i..i + 3).is_some_and(|s| s == [quote; 3]);
            let width = if triple { 3 } else { 1 };
            let start = i + width;
            i = start;
            let mut text = String::new();
            let mut closed = false;
            while i < bytes.len() {
                if bytes
                    .get(i..i + width)
                    .is_some_and(|s| s.iter().all(|c| *c == quote))
                {
                    i += width;
                    closed = true;
                    break;
                }
                if bytes[i] == b'\\' && !(lang == "go" && quote == b'`') {
                    i += 1;
                    if i < bytes.len() {
                        let c = source[i..].chars().next().unwrap_or('\0');
                        text.push(match c {
                            'n' => '\n',
                            'r' => '\r',
                            't' => '\t',
                            c => c,
                        });
                        i += c.len_utf8();
                    }
                } else {
                    let c = source[i..].chars().next().unwrap_or('\0');
                    text.push(c);
                    i += c.len_utf8();
                }
            }
            if !closed {
                unknown.push("unknown: unterminated string".into());
            }
            let dynamic = quote == b'`' && matches!(lang, "js" | "ts") && text.contains("${");
            if dynamic {
                unknown.push("unresolved: template interpolation".into());
            }
            tokens.push(Token {
                text,
                kind: Kind::Literal,
                dynamic,
            });
            continue;
        }
        // JS regexp literals (a conservative expression-start heuristic).
        if matches!(lang, "js" | "ts")
            && quote == b'/'
            && tokens.last().is_none_or(|t| {
                matches!(
                    t.text.as_str(),
                    "=" | "(" | "[" | ":" | "," | "return" | "!"
                )
            })
        {
            i += 1;
            let mut class = false;
            let mut closed = false;
            while i < bytes.len() && bytes[i] != b'\n' {
                match bytes[i] {
                    b'\\' => i = (i + 2).min(bytes.len()),
                    b'[' => {
                        class = true;
                        i += 1;
                    }
                    b']' => {
                        class = false;
                        i += 1;
                    }
                    b'/' if !class => {
                        i += 1;
                        closed = true;
                        break;
                    }
                    _ => i += 1,
                }
            }
            if closed {
                while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
            } else {
                unknown.push("unknown: regexp literal".into());
            }
            tokens.push(Token {
                text: String::new(),
                kind: Kind::Literal,
                dynamic: false,
            });
            continue;
        }
        if is_word(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_word(bytes[i]) {
                i += 1;
            }
            tokens.push(Token {
                text: source[start..i].to_string(),
                kind: Kind::Word,
                dynamic: false,
            });
        } else {
            let c = source[i..].chars().next().unwrap_or('\0');
            tokens.push(Token {
                text: c.to_string(),
                kind: Kind::Punct,
                dynamic: false,
            });
            i += c.len_utf8();
        }
    }
    (tokens, unknown)
}

fn token(tokens: &[Token], index: usize) -> &str {
    tokens.get(index).map_or("", |t| t.text.as_str())
}

fn next_code(tokens: &[Token], mut index: usize) -> usize {
    while tokens.get(index).is_some_and(|t| t.kind == Kind::Newline) {
        index += 1;
    }
    index
}

fn import(kind: &str, spec: String, members: Vec<String>) -> ImportRef {
    ImportRef {
        kind: kind.into(),
        spec,
        members,
    }
}

fn rust_use(tokens: &[Token], prefix: &str, out: &mut Vec<ImportRef>) {
    let mut pieces = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let name = token(tokens, i);
        if name == "as" {
            break;
        }
        if name == "{" {
            let base = format!("{prefix}{}", pieces.join(""));
            let mut level = 1;
            let mut start = i + 1;
            i += 1;
            while i < tokens.len() && level > 0 {
                match token(tokens, i) {
                    "{" => level += 1,
                    "}" => {
                        level -= 1;
                        if level == 0 {
                            rust_use(&tokens[start..i], &base, out);
                        }
                    }
                    "," if level == 1 => {
                        rust_use(&tokens[start..i], &base, out);
                        start = i + 1;
                    }
                    _ => (),
                }
                i += 1;
            }
            return;
        }
        if tokens[i].kind != Kind::Newline && name != ";" {
            pieces.push(name);
        }
        i += 1;
    }
    let mut spec = format!("{prefix}{}", pieces.join(""));
    if spec.ends_with("::self") {
        spec.truncate(spec.len() - 6);
    }
    if !spec.is_empty() {
        out.push(import("rust_use", spec, Vec::new()));
    }
}

fn definition(
    tokens: &[Token],
    index: usize,
    names: &mut BTreeSet<String>,
    declarations: &mut BTreeSet<usize>,
) {
    if let Some(t) = tokens.get(index).filter(|t| t.kind == Kind::Word) {
        names.insert(t.text.clone());
        declarations.insert(index);
    }
}

fn impl_name(tokens: &[Token], mut i: usize) -> Option<String> {
    if token(tokens, i) == "<" {
        let mut depth = 1;
        i += 1;
        while i < tokens.len() && depth > 0 {
            match token(tokens, i) {
                "<" => depth += 1,
                ">" => depth -= 1,
                _ => (),
            }
            i += 1;
        }
    }
    while matches!(token(tokens, i), "&" | "const" | "mut" | "!") {
        i += 1;
    }
    let mut name = tokens.get(i).filter(|t| t.kind == Kind::Word)?.text.clone();
    while token(tokens, i + 1) == ":" && token(tokens, i + 2) == ":" {
        i += 3;
        name = tokens.get(i).filter(|t| t.kind == Kind::Word)?.text.clone();
    }
    Some(name)
}

fn extract(source: &str, path: &str, lang: &str) -> Entry {
    let (tokens, mut unknown) = lex(source, lang);
    let mut symbols = BTreeSet::new();
    let mut declarations = BTreeSet::new();
    let mut imports = Vec::new();
    let mut braces = 0usize;
    let mut module_openings = BTreeMap::new();
    let mut module_scope: Vec<(usize, String)> = Vec::new();
    if source.lines().take(12).any(|line| {
        let line = line.trim().to_lowercase();
        (line.starts_with("//")
            || line.starts_with('#')
            || line.starts_with("/*")
            || line.starts_with('*'))
            && (line.contains("code generated")
                || line.contains("auto-generated")
                || line.contains("autogenerated"))
    }) {
        unknown.push("unresolved: generated code; bindings unknown".into());
    }
    let mut tests = path.split('/').any(|p| p == "tests")
        || Path::new(path).file_name().is_some_and(|s| {
            let s = s.to_string_lossy();
            s.ends_with("_test.rs")
                || s.starts_with("test_") && s.ends_with(".py")
                || s.contains(".spec.")
                || s.ends_with(".test.js")
                || s.ends_with(".test.ts")
                || s.ends_with("_test.go")
        });
    for (i, t) in tokens.iter().enumerate() {
        let word = t.text.as_str();
        if t.kind == Kind::Literal {
            continue;
        }
        match word {
            "{" => {
                braces += 1;
                if let Some(name) = module_openings.remove(&i) {
                    module_scope.push((braces, name));
                }
            }
            "}" => {
                module_scope.retain(|(level, _)| *level < braces);
                braces = braces.saturating_sub(1);
            }
            _ => (),
        }
        let next = next_code(&tokens, i + 1);
        match lang {
            "rs" => {
                if matches!(
                    word,
                    "fn" | "struct" | "enum" | "trait" | "type" | "const" | "static"
                ) && !(word == "const" && token(&tokens, next) == "fn")
                {
                    let name = if word == "static" && token(&tokens, next) == "mut" {
                        next_code(&tokens, next + 1)
                    } else {
                        next
                    };
                    definition(&tokens, name, &mut symbols, &mut declarations);
                }
                if word == "impl" {
                    if let Some(name) = impl_name(&tokens, next) {
                        symbols.insert(name);
                    }
                    let end = (next..tokens.len())
                        .find(|n| token(&tokens, *n) == "{")
                        .unwrap_or(tokens.len());
                    if let Some(n) = (next..end).find(|n| token(&tokens, *n) == "for") {
                        if let Some(name) = impl_name(&tokens, next_code(&tokens, n + 1)) {
                            symbols.insert(name);
                        }
                    }
                }
                if word == "use" {
                    let end = (next..tokens.len())
                        .find(|n| token(&tokens, *n) == ";")
                        .unwrap_or(tokens.len());
                    let first = imports.len();
                    rust_use(&tokens[next..end], "", &mut imports);
                    for reference in &mut imports[first..] {
                        reference.members =
                            module_scope.iter().map(|(_, name)| name.clone()).collect();
                    }
                }
                if word == "mod" && token(&tokens, next_code(&tokens, next + 1)) == ";" {
                    imports.push(import(
                        "rust_mod",
                        token(&tokens, next).into(),
                        module_scope.iter().map(|(_, name)| name.clone()).collect(),
                    ));
                }
                if word == "mod" && token(&tokens, next_code(&tokens, next + 1)) == "{" {
                    module_openings.insert(
                        next_code(&tokens, next + 1),
                        token(&tokens, next).to_string(),
                    );
                }
                if word == "#" && token(&tokens, next) == "[" {
                    let end = (next..tokens.len())
                        .find(|n| token(&tokens, *n) == "]")
                        .unwrap_or(tokens.len());
                    let attribute: String = tokens[next..end]
                        .iter()
                        .filter(|t| t.kind != Kind::Newline)
                        .map(|t| t.text.as_str())
                        .collect();
                    tests |= attribute == "[test" || attribute == "[cfg(test)";
                }
                if t.kind == Kind::Word
                    && token(&tokens, next) == "!"
                    && matches!(
                        token(&tokens, next_code(&tokens, next + 1)),
                        "(" | "[" | "{"
                    )
                {
                    unknown.push(format!("unresolved: macro {word}"));
                }
            }
            "js" | "ts" => {
                if matches!(word, "function" | "class" | "interface" | "type" | "enum") {
                    definition(
                        &tokens,
                        if token(&tokens, next) == "*" {
                            next + 1
                        } else {
                            next
                        },
                        &mut symbols,
                        &mut declarations,
                    );
                }
                if braces == 0 && matches!(word, "const" | "let" | "var") {
                    definition(&tokens, next, &mut symbols, &mut declarations);
                    if matches!(token(&tokens, next), "{" | "[") {
                        unknown.push("unknown: destructured declaration".into());
                    }
                    // Multiple top-level declarations: const a = f(), b = 1.
                    let mut nested = 0usize;
                    let mut j = next;
                    while j < tokens.len()
                        && !(tokens[j].kind == Kind::Punct && token(&tokens, j) == ";")
                        && tokens[j].kind != Kind::Newline
                    {
                        if tokens[j].kind == Kind::Punct {
                            match token(&tokens, j) {
                                "(" | "[" | "{" => nested += 1,
                                ")" | "]" | "}" => nested = nested.saturating_sub(1),
                                "," if nested == 0 => definition(
                                    &tokens,
                                    next_code(&tokens, j + 1),
                                    &mut symbols,
                                    &mut declarations,
                                ),
                                _ => (),
                            }
                        }
                        j += 1;
                    }
                }
                if word == "export" && token(&tokens, next) == "{" {
                    let mut j = next + 1;
                    while j < tokens.len() && token(&tokens, j) != "}" {
                        if tokens[j].kind == Kind::Word && token(&tokens, j) != "as" {
                            symbols.insert(tokens[j].text.clone());
                        }
                        j += 1;
                    }
                }
                if word == "import" || word == "require" {
                    if token(&tokens, next) == "(" {
                        let value = tokens.get(next + 1);
                        if word == "require"
                            && value.is_some_and(|t| t.kind == Kind::Literal && !t.dynamic)
                            && token(&tokens, next + 2) == ")"
                        {
                            imports.push(import("js", value.unwrap().text.clone(), Vec::new()));
                        } else {
                            unknown.push(format!("unresolved: dynamic {word}"));
                        }
                    } else if word == "import" {
                        if let Some(value) = tokens
                            .get(next)
                            .filter(|t| t.kind == Kind::Literal && !t.dynamic)
                        {
                            imports.push(import("js", value.text.clone(), Vec::new()));
                        } else {
                            let mut j = next;
                            while j < tokens.len() && token(&tokens, j) != ";" {
                                if token(&tokens, j) == "from" {
                                    if let Some(value) = tokens
                                        .get(next_code(&tokens, j + 1))
                                        .filter(|t| t.kind == Kind::Literal && !t.dynamic)
                                    {
                                        imports.push(import("js", value.text.clone(), Vec::new()));
                                    } else {
                                        unknown.push("unresolved: import specifier".into());
                                    }
                                    break;
                                }
                                if j > next && token(&tokens, j) == "import" {
                                    break;
                                }
                                j += 1;
                            }
                        }
                    }
                }
                if word == "export" {
                    let mut j = next;
                    while j < tokens.len()
                        && token(&tokens, j) != ";"
                        && tokens[j].kind != Kind::Newline
                    {
                        if token(&tokens, j) == "from" {
                            if let Some(t) = tokens
                                .get(next_code(&tokens, j + 1))
                                .filter(|t| t.kind == Kind::Literal && !t.dynamic)
                            {
                                imports.push(import("js", t.text.clone(), Vec::new()));
                            }
                            break;
                        }
                        j += 1;
                    }
                }
                if word == "(" && matches!(token(&tokens, i.saturating_sub(1)), ")" | "]") {
                    unknown.push("unresolved: indirect invocation".into());
                }
            }
            "py" => {
                if word == "def" || word == "class" {
                    definition(&tokens, next, &mut symbols, &mut declarations);
                }
                if word == "import" {
                    // from ... import is handled at the 'from' token.
                    let start = (0..i)
                        .rev()
                        .find(|n| tokens[*n].kind == Kind::Newline || token(&tokens, *n) == ";")
                        .map_or(0, |n| n + 1);
                    if !(start..i).any(|n| token(&tokens, n) == "from") {
                        let mut spec = String::new();
                        let mut alias = false;
                        for t in &tokens[next..] {
                            if t.kind == Kind::Newline || t.text == ";" || t.text == "," {
                                if !spec.is_empty() {
                                    imports.push(import(
                                        "py",
                                        std::mem::take(&mut spec),
                                        Vec::new(),
                                    ));
                                }
                                alias = false;
                                if t.text != "," {
                                    break;
                                }
                            } else if t.text == "as" {
                                alias = true;
                            } else if !alias && (t.kind == Kind::Word || t.text == ".") {
                                spec.push_str(&t.text);
                            }
                        }
                        if !spec.is_empty() {
                            imports.push(import("py", spec, Vec::new()));
                        }
                    }
                }
                if word == "from" {
                    let mut spec = String::new();
                    let mut j = next;
                    while j < tokens.len()
                        && token(&tokens, j) != "import"
                        && tokens[j].kind != Kind::Newline
                    {
                        if tokens[j].kind == Kind::Word || token(&tokens, j) == "." {
                            spec.push_str(token(&tokens, j));
                        }
                        j += 1;
                    }
                    if token(&tokens, j) == "import" {
                        let mut members = Vec::new();
                        let mut paren = 0usize;
                        let mut alias = false;
                        j += 1;
                        while j < tokens.len() {
                            if token(&tokens, j) == ";"
                                || tokens[j].kind == Kind::Newline && paren == 0
                            {
                                break;
                            }
                            match token(&tokens, j) {
                                "(" => paren += 1,
                                ")" => paren = paren.saturating_sub(1),
                                "as" => alias = true,
                                "," => alias = false,
                                _ if tokens[j].kind == Kind::Word && !alias => {
                                    members.push(tokens[j].text.clone())
                                }
                                _ => (),
                            }
                            j += 1;
                        }
                        imports.push(import("pyfrom", spec, sorted(members)));
                    }
                }
            }
            "go" => {
                if word == "type" {
                    if token(&tokens, next) == "(" {
                        let mut j = next + 1;
                        let mut nested = 0usize;
                        let mut beginning = true;
                        while j < tokens.len() && !(nested == 0 && token(&tokens, j) == ")") {
                            if beginning && nested == 0 && tokens[j].kind == Kind::Word {
                                definition(&tokens, j, &mut symbols, &mut declarations);
                                beginning = false;
                            }
                            match token(&tokens, j) {
                                "{" | "(" | "[" => nested += 1,
                                "}" | ")" | "]" => nested = nested.saturating_sub(1),
                                ";" | "\n" if nested == 0 => beginning = true,
                                _ => (),
                            }
                            j += 1;
                        }
                    } else {
                        definition(&tokens, next, &mut symbols, &mut declarations);
                    }
                }
                if word == "func" {
                    let name = if token(&tokens, next) == "(" {
                        (next + 1..tokens.len())
                            .find(|n| token(&tokens, *n) == ")")
                            .map(|n| next_code(&tokens, n + 1))
                            .unwrap_or(tokens.len())
                    } else {
                        next
                    };
                    definition(&tokens, name, &mut symbols, &mut declarations);
                    tests |= token(&tokens, name).starts_with("Test");
                }
                if word == "import" {
                    let mut j = next;
                    if token(&tokens, j) == "(" {
                        j += 1;
                        while j < tokens.len() && token(&tokens, j) != ")" {
                            if tokens[j].kind == Kind::Literal {
                                imports.push(import("go", tokens[j].text.clone(), Vec::new()));
                            }
                            j += 1;
                        }
                    } else {
                        while j < tokens.len()
                            && tokens[j].kind != Kind::Newline
                            && token(&tokens, j) != ";"
                        {
                            if tokens[j].kind == Kind::Literal {
                                imports.push(import("go", tokens[j].text.clone(), Vec::new()));
                                break;
                            }
                            j += 1;
                        }
                    }
                }
            }
            _ => (),
        }
    }
    let keywords = [
        "if", "for", "while", "switch", "match", "catch", "with", "return", "sizeof", "typeof",
        "fn", "func", "function", "def", "class", "import", "require", "cfg",
    ];
    let mut calls = BTreeSet::new();
    let mut static_calls = BTreeSet::new();
    for (i, t) in tokens.iter().enumerate() {
        if t.kind == Kind::Punct
            && t.text == "("
            && i.checked_sub(1)
                .is_some_and(|n| matches!(token(&tokens, n), ")" | "]"))
        {
            unknown.push("unresolved: indirect invocation".into());
        }
        if t.kind != Kind::Word
            || t.text.as_bytes().first().is_some_and(u8::is_ascii_digit)
            || declarations.contains(&i)
            || keywords.contains(&t.text.as_str())
        {
            continue;
        }
        let next = next_code(&tokens, i + 1);
        if token(&tokens, next) != "(" {
            continue;
        }
        calls.insert(t.text.clone());
        let previous = i.checked_sub(1).map_or("", |n| token(&tokens, n));
        if previous == "." || previous == "?" {
            unknown.push(format!("unresolved: dynamic dispatch {}", t.text));
        } else if previous != "#" {
            static_calls.insert(t.text.clone());
        }
    }
    if calls.len() > MAX_CALLS {
        unknown.push("unknown: calls truncated at 200 names".into());
    }
    let calls: Vec<_> = calls.into_iter().take(MAX_CALLS).collect();
    static_calls.retain(|s| calls.binary_search(s).is_ok());
    imports.sort_by(|a, b| (&a.kind, &a.spec, &a.members).cmp(&(&b.kind, &b.spec, &b.members)));
    imports.dedup();
    Entry {
        hash: digest(source.as_bytes()),
        size: source.len() as u64,
        mtime: 0,
        lang: lang.into(),
        imports: Vec::new(),
        symbols: symbols.into_iter().collect(),
        calls,
        static_calls: static_calls.into_iter().collect(),
        import_specs: imports,
        tests,
        truncated: false,
        unknown: sorted(unknown),
    }
}

fn module_dir(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or(Path::new(""));
    if matches!(
        path.file_name().and_then(|s| s.to_str()),
        Some("lib.rs" | "main.rs" | "mod.rs")
    ) {
        parent.to_path_buf()
    } else {
        parent.join(path.file_stem().unwrap_or_default())
    }
}

fn choose(candidates: Vec<PathBuf>, files: &BTreeMap<String, Entry>) -> Vec<String> {
    let present = sorted(
        candidates
            .into_iter()
            .filter_map(|p| normal_path(&p).map(|p| relative(&p)))
            .filter(|p| files.contains_key(p)),
    );
    // Two plausible files are ambiguous; keep the original raw specifier.
    if present.len() == 1 {
        present
    } else {
        Vec::new()
    }
}

fn resolve(
    reference: &ImportRef,
    source: &str,
    files: &BTreeMap<String, Entry>,
    go_module: &str,
) -> Vec<String> {
    let path = Path::new(source);
    let parent = path.parent().unwrap_or(Path::new(""));
    let spec = reference.spec.as_str();
    match reference.kind.as_str() {
        "rust_mod" => {
            let base = reference
                .members
                .iter()
                .fold(module_dir(path), |p, name| p.join(name))
                .join(spec);
            choose(vec![base.with_extension("rs"), base.join("mod.rs")], files)
        }
        "rust_use" => {
            let parts: Vec<_> = spec
                .trim_start_matches("::")
                .trim_end_matches("::*")
                .split("::")
                .collect();
            let mut start = 0;
            let mut base = PathBuf::new();
            if parts.first() == Some(&"crate") {
                start = 1;
                base = parent
                    .ancestors()
                    .find_map(|p| {
                        if files.contains_key(&relative(&p.join("lib.rs")))
                            || files.contains_key(&relative(&p.join("main.rs")))
                        {
                            Some(p.to_path_buf())
                        } else if files.contains_key(&relative(&p.join("src/lib.rs")))
                            || files.contains_key(&relative(&p.join("src/main.rs")))
                        {
                            Some(p.join("src"))
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| PathBuf::from("src"));
            } else if parts.first() == Some(&"self") {
                start = 1;
                base = reference
                    .members
                    .iter()
                    .fold(module_dir(path), |p, name| p.join(name));
            } else if parts.first() == Some(&"super") {
                base = reference
                    .members
                    .iter()
                    .fold(module_dir(path), |p, name| p.join(name));
                while parts.get(start) == Some(&"super") {
                    if !base.pop() {
                        return Vec::new();
                    }
                    start += 1;
                }
            }
            let bases = if start == 0 {
                vec![parent.to_path_buf(), PathBuf::from("src"), PathBuf::new()]
            } else {
                vec![base]
            };
            for count in (start + 1..=parts.len()).rev() {
                let mut candidates = Vec::new();
                for base in &bases {
                    let p = parts[start..count]
                        .iter()
                        .fold(base.clone(), |p, part| p.join(part));
                    candidates.push(p.with_extension("rs"));
                    candidates.push(p.join("mod.rs"));
                }
                let resolved = choose(candidates, files);
                if !resolved.is_empty() {
                    return resolved;
                }
            }
            if start > 0 && parts.len() == start + 1 {
                if parts.first() == Some(&"self")
                    && reference.members.is_empty()
                    && files
                        .get(source)
                        .is_some_and(|e| e.symbols.iter().any(|s| s == parts[start]))
                {
                    return vec![source.to_string()];
                }
                let candidates: Vec<_> = bases
                    .iter()
                    .flat_map(|p| [p.join("mod.rs"), p.join("lib.rs"), p.join("main.rs")])
                    .collect();
                let resolved = choose(candidates, files);
                if !resolved.is_empty() {
                    return resolved;
                }
            }
            Vec::new()
        }
        "js" => {
            if !spec.starts_with('.') {
                return Vec::new();
            }
            let base = parent.join(spec);
            if files.contains_key(&relative(&normal_path(&base).unwrap_or_default())) {
                return choose(vec![base], files);
            }
            let mut candidates = Vec::new();
            for ext in ["js", "mjs", "cjs", "jsx", "ts", "tsx"] {
                if base.extension().is_none() {
                    candidates.push(base.with_extension(ext));
                }
                // TypeScript commonly writes .js specifiers for .ts source.
                if base.extension().is_some_and(|s| s == "js") && matches!(ext, "ts" | "tsx") {
                    candidates.push(base.with_extension(ext));
                }
                candidates.push(base.join(format!("index.{ext}")));
            }
            choose(candidates, files)
        }
        "py" | "pyfrom" => {
            let dots = spec.chars().take_while(|c| *c == '.').count();
            let suffix = spec[dots..].replace('.', "/");
            let bases = if dots > 0 {
                let mut base = parent.to_path_buf();
                for _ in 1..dots {
                    if !base.pop() {
                        return Vec::new();
                    }
                }
                vec![base]
            } else {
                vec![PathBuf::new(), PathBuf::from("src"), parent.to_path_buf()]
            };
            let mut candidates = Vec::new();
            for base in &bases {
                let base = base.join(&suffix);
                if !suffix.is_empty() {
                    candidates.push(base.with_extension("py"));
                }
                candidates.push(base.join("__init__.py"));
            }
            let mut resolved = choose(candidates, files);
            if reference.kind == "pyfrom" {
                for member in &reference.members {
                    let candidates = bases
                        .iter()
                        .flat_map(|base| {
                            let base = base.join(&suffix).join(member);
                            [base.with_extension("py"), base.join("__init__.py")]
                        })
                        .collect();
                    resolved.extend(choose(candidates, files));
                }
            }
            sorted(resolved)
        }
        "go" => {
            let directory = if let Some(local) = spec.strip_prefix("./") {
                parent.join(local)
            } else if !go_module.is_empty() && spec == go_module {
                PathBuf::new()
            } else if !go_module.is_empty() {
                match spec.strip_prefix(&format!("{go_module}/")) {
                    Some(p) => PathBuf::from(p),
                    None => return Vec::new(),
                }
            } else {
                return Vec::new();
            };
            let Some(dir) = normal_path(&directory) else {
                return Vec::new();
            };
            let dir = relative(&dir);
            files
                .iter()
                .filter(|(p, entry)| {
                    entry.lang == "go"
                        && !p.ends_with("_test.go")
                        && relative(Path::new(p).parent().unwrap_or(Path::new(""))) == dir
                })
                .map(|(p, _)| p.clone())
                .collect()
        }
        _ => Vec::new(),
    }
}

fn read_go_module(root: &Path, reader: Option<&Root>, unknown: &mut Vec<String>) -> String {
    let Some(source) = read_config(root, reader, &root.join("go.mod"), unknown) else {
        return String::new();
    };
    source
        .lines()
        .find_map(|line| {
            let mut words = line.split_whitespace();
            (words.next() == Some("module"))
                .then(|| words.next().unwrap_or("").trim_matches('"').to_string())
        })
        .unwrap_or_default()
}

impl Entry {
    fn value(&self) -> Value {
        json!({"hash":self.hash,"size":self.size,"mtime":self.mtime,"lang":self.lang,
            "imports":self.imports,"symbols":self.symbols,"calls":self.calls,"tests":self.tests,
            "truncated":self.truncated,"unknown":self.unknown,"static_calls":self.static_calls,
            "import_specs":self.import_specs.iter().map(|r| json!({"kind":r.kind,"spec":r.spec,"members":r.members})).collect::<Vec<_>>()})
    }

    fn from_value(v: &Value) -> Option<Self> {
        fn strings(v: &Value, name: &str) -> Option<Vec<String>> {
            v.get(name)?
                .as_array()?
                .iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect()
        }
        let hash = v.get("hash")?.as_str()?.to_string();
        if hash.len() != 16 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let refs = v
            .get("import_specs")?
            .as_array()?
            .iter()
            .map(|r| {
                Some(ImportRef {
                    kind: r.get("kind")?.as_str()?.into(),
                    spec: r.get("spec")?.as_str()?.into(),
                    members: strings(r, "members")?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            hash,
            size: v.get("size")?.as_u64()?,
            mtime: v.get("mtime")?.as_u64()?,
            lang: v.get("lang")?.as_str()?.into(),
            imports: sorted(strings(v, "imports")?),
            symbols: sorted(strings(v, "symbols")?),
            calls: sorted(strings(v, "calls")?),
            static_calls: sorted(strings(v, "static_calls")?),
            import_specs: refs,
            tests: v.get("tests")?.as_bool()?,
            truncated: v.get("truncated")?.as_bool()?,
            unknown: sorted(strings(v, "unknown")?),
        })
    }
}

struct Graph {
    reverse: BTreeMap<String, BTreeSet<String>>,
    symbols: BTreeMap<String, BTreeSet<String>>,
    edges: usize,
    unresolved: usize,
}

fn symbol_language(lang: &str) -> &str {
    if matches!(lang, "js" | "ts") {
        "js-ts"
    } else {
        lang
    }
}

impl Graph {
    fn new(index: &Index) -> Self {
        let mut symbols: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut symbols_by_lang: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
        for (path, entry) in &index.files {
            for symbol in &entry.symbols {
                symbols
                    .entry(symbol.clone())
                    .or_default()
                    .insert(path.clone());
                symbols_by_lang
                    .entry((symbol_language(&entry.lang).to_string(), symbol.clone()))
                    .or_default()
                    .insert(path.clone());
            }
        }
        let mut edges = BTreeSet::new();
        let mut unresolved = index.unknown.len();
        for (path, entry) in &index.files {
            unresolved += entry.unknown.len();
            for imported in &entry.imports {
                if index.files.contains_key(imported) {
                    if path != imported {
                        edges.insert((path.clone(), imported.clone()));
                    }
                } else {
                    unresolved += 1;
                }
            }
            for called in &entry.static_calls {
                // Resolve same-file and directly imported definitions first.
                let candidates = symbols_by_lang
                    .get(&(symbol_language(&entry.lang).to_string(), called.clone()));
                let mut definitions = BTreeSet::new();
                if let Some(candidates) = candidates {
                    for imported in std::iter::once(path).chain(entry.imports.iter()) {
                        if candidates.contains(imported) {
                            definitions.insert(imported.clone());
                        }
                    }
                }
                if definitions.is_empty() {
                    // Same-language name matches are potential edges, with
                    // an unknown binding counted in unresolved. Two paths are
                    // enough to distinguish unique from ambiguous; avoid
                    // walking every definition of common names such as `run`.
                    definitions = candidates.into_iter().flatten().take(2).cloned().collect();
                    if definitions.len() == 1 {
                        unresolved += 1;
                    }
                }
                if definitions.len() == 1 {
                    for target in definitions {
                        if target != *path {
                            edges.insert((path.clone(), target));
                        }
                    }
                } else {
                    unresolved += 1;
                }
            }
        }
        let mut reverse: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (source, target) in &edges {
            reverse
                .entry(target.clone())
                .or_default()
                .insert(source.clone());
        }
        Self {
            reverse,
            symbols,
            edges: edges.len(),
            unresolved,
        }
    }
}

impl Index {
    fn value(&self) -> Value {
        let graph = Graph::new(self);
        let files: serde_json::Map<_, _> = self
            .files
            .iter()
            .map(|(p, e)| (p.clone(), e.value()))
            .collect();
        json!({"schema":1,"extractor":1,"root":self.root,"built_at_unix":self.built_at_unix,"files":files,"go_module":self.go_module,
            "stats":{"files":self.files.len(),"edges":graph.edges,"unresolved":graph.unresolved},
            "unknown":self.unknown,"approximation":NOTE})
    }

    fn from_value(value: &Value, root: &Path) -> Option<Self> {
        if value.get("schema")?.as_u64()? != 1
            || value.get("extractor")?.as_u64()? != 1
            || value.get("root")?.as_str()? != root.to_str()?
        {
            return None;
        }
        let mut files = BTreeMap::new();
        for (path, entry) in value.get("files")?.as_object()? {
            if relative(&normal_path(Path::new(path))?) != *path
                || language(Path::new(path)).is_none()
            {
                return None;
            }
            files.insert(path.clone(), Entry::from_value(entry)?);
        }
        if files.len() > MAX_FILES {
            return None;
        }
        let index = Self {
            root: root.to_str()?.into(),
            built_at_unix: value.get("built_at_unix")?.as_u64()?,
            go_module: value.get("go_module")?.as_str()?.into(),
            files,
            unknown: value
                .get("unknown")?
                .as_array()?
                .iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()?,
        };
        let graph = Graph::new(&index);
        let stats = value.get("stats")?;
        if stats.get("files")?.as_u64()? != index.files.len() as u64
            || stats.get("edges")?.as_u64()? != graph.edges as u64
            || stats.get("unresolved")?.as_u64()? != graph.unresolved as u64
        {
            return None;
        }
        Some(index)
    }
}

fn load_index(root: &Path, home: &Path) -> Option<Index> {
    load_index_with_mtime(root, home).map(|(index, _)| index)
}

fn load_index_with_mtime(root: &Path, home: &Path) -> Option<(Index, SystemTime)> {
    let path = index_path(root, home);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INDEX_BYTES {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Also reject a symlink/FIFO substituted after the metadata check.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INDEX_BYTES {
        return None;
    }
    // Detect growth past the shared limit before parsing even a valid prefix.
    let mut bytes = Vec::new();
    file.take(MAX_INDEX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return None;
    }
    let value = serde_json::from_slice(&bytes).ok()?;
    Some((Index::from_value(&value, root)?, metadata.modified().ok()?))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_INDEX_BYTES,
        "index too large ({} bytes > {} byte limit): unknown",
        bytes.len(),
        MAX_INDEX_BYTES
    );
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().context("unknown: index parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = None;
    for _ in 0..32 {
        let candidate = parent.join(format!(
            ".rdsh-{}-{}.tmp",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // The index lists repository paths and symbol names; keep it owner
            // only like the memory store and the hook config.
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
    }
    let (temporary, mut file) = temporary.context("unknown: could not allocate temporary index")?;
    let result = (|| -> Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn build_index(root: &Path, home: &Path, force: bool) -> Result<(Index, usize)> {
    let previous = load_index(root, home);
    let reader = Root::new(root);
    let mut scanned = scan(root, reader.as_ref());
    let go_module = read_go_module(root, reader.as_ref(), &mut scanned.unknown);
    let mut index = Index {
        root: root.to_str().context("unknown: root encoding")?.into(),
        built_at_unix: 0,
        go_module,
        files: BTreeMap::new(),
        unknown: sorted(scanned.unknown),
    };
    let mut parsed = 0;
    for (path, (size, modified)) in scanned.files {
        let file = reader.as_ref().and_then(|r| r.open(&root.join(&path)));
        if file.is_some() && !force && modified != 0 {
            if let Some(old) = previous
                .as_ref()
                .and_then(|p| p.files.get(&path))
                .filter(|e| {
                    e.size == size
                        && e.mtime == modified
                        && !e
                            .unknown
                            .iter()
                            .any(|s| s.contains("read failed") || s.contains("changed while"))
                })
            {
                index.files.insert(path, old.clone());
                continue;
            }
        }
        let lang = language(Path::new(&path)).unwrap_or("unknown");
        let mut bytes = Vec::new();
        let read = file.is_some_and(|file| file.take(MAX_BYTES).read_to_end(&mut bytes).is_ok());
        parsed += 1;
        let source = String::from_utf8_lossy(&bytes);
        let mut entry = extract(&source, &path, lang);
        entry.hash = digest(&bytes);
        entry.size = size;
        entry.mtime = modified;
        entry.truncated = size > MAX_BYTES;
        if entry.truncated {
            entry
                .unknown
                .push("unknown: truncated source (hash covers first 512KiB)".into());
        }
        if !read {
            entry.unknown.push("unknown: source read failed".into());
        }
        if std::str::from_utf8(&bytes).is_err() {
            entry.unknown.push("unknown: non-UTF-8 source".into());
        }
        if fs::symlink_metadata(root.join(&path))
            .ok()
            .is_none_or(|m| m.len() != size || mtime(&m) != Some(modified))
        {
            entry
                .unknown
                .push("unknown: source changed while indexing".into());
        }
        entry.unknown = sorted(entry.unknown);
        index.files.insert(path, entry);
    }
    let resolved: Vec<_> = index
        .files
        .iter()
        .map(|(path, entry)| {
            let imports = entry
                .import_specs
                .iter()
                .flat_map(|r| {
                    let paths = resolve(r, path, &index.files, &index.go_module);
                    if paths.is_empty() {
                        vec![format!("raw:{}", r.spec)]
                    } else {
                        paths
                    }
                })
                .collect::<Vec<_>>();
            (path.clone(), sorted(imports))
        })
        .collect();
    for (path, imports) in resolved {
        if let Some(entry) = index.files.get_mut(&path) {
            entry.imports = imports;
        }
    }
    index.built_at_unix = previous
        .as_ref()
        .filter(|p| {
            p.files == index.files && p.unknown == index.unknown && p.go_module == index.go_module
        })
        .map_or_else(
            || {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs())
            },
            |p| p.built_at_unix,
        );
    let bytes = serde_json::to_vec(&index.value())?;
    atomic_write(&index_path(root, home), &bytes).context("could not write dependency index")?;
    Ok((index, parsed))
}

fn stale(index: &Index, root: &Path) -> bool {
    let reader = Root::new(root);
    let mut scanned = scan(root, reader.as_ref());
    let go_module = read_go_module(root, reader.as_ref(), &mut scanned.unknown);
    !scanned.unknown.is_empty()
        || scanned.unknown != index.unknown
        || go_module != index.go_module
        || scanned.files.len() != index.files.len()
        || scanned.files.iter().any(|(p, (size, modified))| {
            index
                .files
                .get(p)
                .is_none_or(|e| e.size != *size || e.mtime != *modified)
        })
        || index.files.values().any(|e| {
            e.unknown
                .iter()
                .any(|s| s.contains("read failed") || s.contains("changed while"))
        })
}

fn current_index() -> Option<(PathBuf, Index)> {
    let root = repository_root(None).ok()?;
    let index = load_index(&root, Path::new(&crate::inspect::dsh_home()))?;
    Some((root, index))
}

fn ensure_index() -> Result<(PathBuf, Index)> {
    let root = repository_root(None)?;
    let home = PathBuf::from(crate::inspect::dsh_home());
    let index = match load_index(&root, &home) {
        Some(index) if !stale(&index, &root) => index,
        _ => build_index(&root, &home, false)?.0,
    };
    Ok((root, index))
}

fn neighbours(index: &Index, seeds: &[String], max: usize) -> Vec<String> {
    let seeds: BTreeSet<_> = seeds
        .iter()
        .filter_map(|s| normal_path(Path::new(s)).map(|p| relative(&p)))
        .collect();
    let mut related = BTreeSet::new();
    for (path, entry) in &index.files {
        if seeds.contains(path) {
            related.extend(
                entry
                    .imports
                    .iter()
                    .filter(|p| index.files.contains_key(*p))
                    .cloned(),
            );
        } else if entry.imports.iter().any(|p| seeds.contains(p)) {
            related.insert(path.clone());
        }
    }
    related
        .into_iter()
        .filter(|p| !seeds.contains(p))
        .take(max)
        .collect()
}

fn related_at(root: &Path, home: &Path, seeds: &[String], max: usize) -> Vec<String> {
    let Some((index, indexed_at)) = load_index_with_mtime(root, home) else {
        return Vec::new();
    };
    // Stat only the seeds; a full freshness walk does not belong in injection.
    if seeds.iter().any(|seed| {
        let Some(path) = normal_path(Path::new(seed)) else {
            return true;
        };
        fs::symlink_metadata(root.join(path))
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .is_none_or(|modified| modified > indexed_at)
    }) {
        return Vec::new();
    }
    neighbours(&index, seeds, max)
}

/// Import targets + importers, sorted cwd-relative paths, without walking the tree.
/// Missing/invalid indexes or seeds newer than the index yield no neighbours.
pub fn related_files(seeds: &[String], max: usize) -> Vec<String> {
    if max == 0 {
        return Vec::new();
    }
    let (Ok(root), Ok(cwd)) = (repository_root(None), std::env::current_dir()) else {
        return Vec::new();
    };
    // The root is canonical, so compare an equally canonical cwd: a plain
    // Windows current_dir() has no verbatim \\?\ prefix and never matches, and a
    // symlinked ancestor would not match on any platform.
    let Ok(cwd) = fs::canonicalize(&cwd) else {
        return Vec::new();
    };
    let Ok(prefix) = cwd.strip_prefix(&root) else {
        return Vec::new();
    };
    let Some(seeds) = seeds
        .iter()
        .map(|seed| normal_path(&prefix.join(seed)).map(|p| relative(&p)))
        .collect::<Option<Vec<_>>>()
    else {
        return Vec::new();
    };
    sorted(
        related_at(&root, Path::new(&crate::inspect::dsh_home()), &seeds, max)
            .into_iter()
            .map(|path| {
                let path = Path::new(&path);
                let common = prefix
                    .components()
                    .zip(path.components())
                    .take_while(|(a, b)| a == b)
                    .count();
                // Index keys are "/"-joined on every platform, so build the
                // cwd-relative result the same way; a plain PathBuf would
                // stringify with backslash separators on Windows and stop
                // matching the keys.
                let mut parts: Vec<String> = Vec::new();
                for _ in common..prefix.components().count() {
                    parts.push("..".to_string());
                }
                for part in path.components().skip(common) {
                    parts.push(part.as_os_str().to_string_lossy().into_owned());
                }
                parts.join("/")
            }),
    )
}

/// True when a valid, parseable index exists for the current repository.
///
/// Parses at most `MAX_INDEX_BYTES` of a regular file; never walks the tree.
/// Use [`graph_summary`] when the caller also needs a full freshness walk.
pub fn index_present() -> bool {
    let Ok(root) = repository_root(None) else {
        return false;
    };
    load_index(&root, Path::new(&crate::inspect::dsh_home())).is_some()
}

/// Empty when unknown; otherwise a one-line static-approximation summary.
///
/// This walks the repository to report staleness, so it is for user-invoked
/// commands, not for the per-turn injection path.
pub fn graph_summary() -> String {
    current_index().map_or_else(String::new, |(root, index)| {
        let graph = Graph::new(&index);
        format!("deps: {} files, {} edges, index {}, {} unresolved (static approximation; dynamic dispatch/indirect calls/macros/generated code: unknown)", index.files.len(), graph.edges, if stale(&index, &root) { "stale" } else { "fresh" }, graph.unresolved)
    })
}

/// Incrementally rebuild the index; `force` re-parses every file.
pub fn cmd_build(root: Option<String>, force: bool, json_output: bool) -> Result<()> {
    let root = repository_root(root.as_deref())?;
    let home = PathBuf::from(crate::inspect::dsh_home());
    let (index, parsed) = build_index(&root, &home, force)?;
    if json_output {
        // The parsed/reused split is a property of this run, not of the index,
        // so it is added to the printed value only.
        let mut value = index.value();
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "build".into(),
                json!({"parsed": parsed, "reused": index.files.len().saturating_sub(parsed)}),
            );
        }
        println!("{value}");
    } else {
        let graph = Graph::new(&index);
        println!(
            "deps: {} files, {} edges, {} unresolved\nindex: {}\n{}",
            index.files.len(),
            graph.edges,
            graph.unresolved,
            index_path(&root, &home).display(),
            NOTE
        );
        for reason in &index.unknown {
            println!("{reason}");
        }
    }
    Ok(())
}

fn candidates(index: &Index, query: &str) -> Vec<String> {
    let graph = Graph::new(index);
    let values: BTreeSet<_> = index
        .files
        .keys()
        .chain(graph.symbols.keys())
        .cloned()
        .collect();
    let needle = query.to_lowercase();
    let mut scored: Vec<_> = values
        .into_iter()
        .map(|v| {
            let lower = v.to_lowercase();
            let score = if lower.starts_with(&needle) {
                0
            } else if lower.contains(&needle) || needle.contains(&lower) {
                1
            } else {
                2
            };
            (score, v)
        })
        .collect();
    scored.sort();
    scored.into_iter().take(10).map(|(_, p)| p).collect()
}

fn query_value(index: &Index, symbol: &str) -> Value {
    let graph = Graph::new(index);
    let definitions: Vec<_> = graph
        .symbols
        .get(symbol)
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    let references: Vec<_> = index
        .files
        .iter()
        .filter(|(_, e)| {
            e.calls.iter().any(|s| s == symbol) || e.imports.iter().any(|p| definitions.contains(p))
        })
        .map(|(p, _)| p.clone())
        .collect();
    let found = !definitions.is_empty() || !references.is_empty();
    json!({"symbol":symbol,"definitions":definitions,"references":references,"found":found,
        "status":if found { if definitions.is_empty() { "unknown_definition" } else { "found" } } else { "unknown" },
        "candidates":if found { Vec::new() } else { candidates(index, symbol) },"unresolved":graph.unresolved,"approximation":NOTE})
}

/// Definition and reference files. Unknown symbols produce exit code 1.
pub fn cmd_query(symbol: String, json_output: bool) -> Result<()> {
    let (_, index) = ensure_index()?;
    let value = query_value(&index, &symbol);
    if json_output {
        println!("{value}");
    } else {
        println!("symbol: {symbol}");
        for key in ["definitions", "references", "candidates"] {
            println!("{key}:");
            for path in value[key].as_array().into_iter().flatten() {
                if let Some(path) = path.as_str() {
                    println!("  {path}");
                }
            }
        }
        if value["definitions"].as_array().is_none_or(Vec::is_empty) {
            println!("definition: unknown");
        }
        println!("{NOTE}");
    }
    anyhow::ensure!(
        value["found"] == true,
        "unknown: symbol not found: {symbol}"
    );
    Ok(())
}

fn impact_value(index: &Index, target: &str, depth: usize, is_stale: bool) -> Value {
    let graph = Graph::new(index);
    let depth = depth.min(8);
    let path = normal_path(Path::new(target)).map(|p| relative(&p));
    let file = path.filter(|p| index.files.contains_key(p));
    let (kind, seeds) = if let Some(path) = file {
        ("file", BTreeSet::from([path]))
    } else if let Some(definitions) = graph.symbols.get(target) {
        ("symbol", definitions.clone())
    } else {
        ("unknown", BTreeSet::new())
    };
    let mut direct = BTreeSet::new();
    for seed in &seeds {
        direct.extend(graph.reverse.get(seed).into_iter().flatten().cloned());
    }
    if kind == "symbol" {
        direct.extend(
            index
                .files
                .iter()
                .filter(|(_, e)| e.static_calls.iter().any(|s| s == target))
                .map(|(p, _)| p.clone()),
        );
    }
    direct.retain(|p| !seeds.contains(p));
    let mut visited = seeds.clone();
    visited.extend(direct.iter().cloned());
    let mut frontier = direct.clone();
    let mut transitive = BTreeSet::new();
    for _ in 1..depth {
        let mut next = BTreeSet::new();
        for path in &frontier {
            for source in graph.reverse.get(path).into_iter().flatten() {
                if visited.insert(source.clone()) {
                    next.insert(source.clone());
                    transitive.insert(source.clone());
                }
            }
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }
    let tests: Vec<_> = visited
        .iter()
        .filter(|p| index.files.get(*p).is_some_and(|e| e.tests))
        .cloned()
        .collect();
    json!({"target":target,"kind":kind,"status":if kind == "unknown" { "unknown" } else { "found" },
        "direct":direct.into_iter().collect::<Vec<_>>(),"transitive":transitive.into_iter().collect::<Vec<_>>(),
        "tests":tests,"depth":depth,"unresolved":graph.unresolved,
        "index":{"files":index.files.len(),"edges":graph.edges,"stale":is_stale},
        "candidates":if kind == "unknown" { candidates(index, target) } else { Vec::new() },"approximation":NOTE})
}

/// Direct/transitive dependents and affected tests; never guesses unknown targets.
pub fn cmd_impact(target: String, depth: usize, json_output: bool) -> Result<()> {
    let (root, index) = ensure_index()?;
    let value = impact_value(&index, &target, depth, stale(&index, &root));
    if json_output {
        println!("{value}");
    } else {
        println!(
            "impact: {target} ({}) depth={} unresolved={}",
            value["kind"].as_str().unwrap_or("unknown"),
            value["depth"],
            value["unresolved"]
        );
        for key in ["direct", "transitive", "tests", "candidates"] {
            println!("{key}:");
            for path in value[key].as_array().into_iter().flatten() {
                if let Some(path) = path.as_str() {
                    println!("  {path}");
                }
            }
        }
        if value["status"] == "unknown" {
            println!("unknown: target not found");
        }
        println!("{NOTE}");
    }
    anyhow::ensure!(
        value["status"] != "unknown",
        "unknown: target not found: {target}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp {
        path: PathBuf,
    }
    impl Temp {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "rdsh-deps-{}-{suffix}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self {
                path: fs::canonicalize(path).unwrap(),
            }
        }
        fn write(&self, name: &str, text: &str) {
            let path = self.path.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn home(&self) -> PathBuf {
            self.path.join("home")
        }
        fn build(&self) -> (Index, usize) {
            build_index(&self.path, &self.home(), false).unwrap()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn contains(items: &[String], name: &str) -> bool {
        items.iter().any(|item| item == name)
    }

    fn dependency_subprocess(temp: &Temp, cwd: &str, action: &str) {
        // Re-enter this test binary as the worker; current_exe() already
        // carries the platform suffix (`.exe` on Windows) and needs no PATH
        // lookup. CARGO_BIN_EXE_* is not set for unit tests, and the rdsh CLI
        // cannot run the worker action. Cwd and DSH_HOME must not change in the
        // parallel parent test process, so pass both to the child only.
        let worker = std::env::current_exe().unwrap();
        let output = std::process::Command::new(&worker)
            .args([
                "--quiet",
                "--exact",
                "deps::tests::dependency_subprocess_checks",
                "--nocapture",
                "--test-threads=1",
            ])
            .current_dir(temp.path.join(cwd))
            .env("DSH_HOME", temp.home())
            .env("RDSH_DEPS_TEST_ACTION", action)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "dependency subprocess {action} failed in {} ({}):\n{}\n{}",
            temp.path.display(),
            worker.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn dependency_subprocess_checks() {
        let Ok(action) = std::env::var("RDSH_DEPS_TEST_ACTION") else {
            return;
        };
        match action.as_str() {
            "index-present" => assert!(index_present()),
            "index-absent" => assert!(!index_present()),
            "related-cwd" | "related-deeper" | "related-newer" => {
                let deeper = action == "related-deeper";
                let seed = if deeper { "../main.js" } else { "main.js" };
                let expected = if deeper {
                    vec!["../../shared.js", "../nearby.js"]
                } else {
                    vec!["../shared.js", "nearby.js"]
                };
                let paths = related_files(&[seed.into()], 5);
                assert_eq!(paths, expected);
                for path in paths {
                    assert!(fs::read_to_string(path).is_ok());
                }
                assert_eq!(
                    related_files(
                        &[if deeper {
                            "../../main.js"
                        } else {
                            "../main.js"
                        }
                        .into()],
                        5
                    ),
                    vec![if deeper {
                        "../../decoy.js"
                    } else {
                        "../decoy.js"
                    }]
                );
                if action == "related-newer" {
                    let root = repository_root(None).unwrap();
                    let indexed_at =
                        fs::metadata(index_path(&root, Path::new(&crate::inspect::dsh_home())))
                            .unwrap()
                            .modified()
                            .unwrap();
                    let file = OpenOptions::new().write(true).open(seed).unwrap();
                    file.set_times(
                        fs::FileTimes::new()
                            .set_modified(indexed_at + std::time::Duration::from_secs(2)),
                    )
                    .unwrap();
                    assert!(fs::metadata(seed).unwrap().modified().unwrap() > indexed_at);
                    assert!(related_files(&[seed.into()], 5).is_empty());
                    assert!(related_files(&["nearby.js".into(), seed.into()], 5).is_empty());
                    // Presence means parseable, even if seed stats are stale.
                    assert!(index_present());
                }
            }
            _ => panic!("unknown dependency test action"),
        }
    }

    fn cwd_repo(temp: &Temp) {
        fs::create_dir(temp.path.join(".git")).unwrap();
        fs::create_dir_all(temp.path.join("src/deep")).unwrap();
        temp.write("src/main.js", "import './nearby'; import '../shared';");
        temp.write("src/nearby.js", "export function nearby() {}");
        temp.write("shared.js", "export function shared() {}");
        temp.write("main.js", "import './decoy';");
        temp.write("decoy.js", "export function decoy() {}");
        temp.build();
    }

    #[test]
    fn related_files_from_subdirectories_are_openable_and_do_not_mix_same_names() {
        let temp = Temp::new();
        cwd_repo(&temp);
        dependency_subprocess(&temp, "src", "related-cwd");
        dependency_subprocess(&temp, "src/deep", "related-deeper");
    }

    #[test]
    fn related_files_reject_any_seed_touched_after_indexing() {
        let temp = Temp::new();
        cwd_repo(&temp);
        dependency_subprocess(&temp, "src", "related-newer");
    }

    #[test]
    fn index_presence_requires_a_valid_parse_but_does_not_check_the_tree() {
        let temp = Temp::new();
        temp.write("main.rs", "fn main() {}");
        let (index, _) = temp.build();
        temp.write(".gitignore", "main.rs\n");
        dependency_subprocess(&temp, "", "index-present");
        let path = index_path(&temp.path, &temp.home());
        for invalid in ["{}", "{", "not json"] {
            fs::write(&path, invalid).unwrap();
            dependency_subprocess(&temp, "", "index-absent");
        }
        let mut corrupt = index.value();
        corrupt["stats"]["files"] = json!(500);
        fs::write(&path, corrupt.to_string()).unwrap();
        dependency_subprocess(&temp, "", "index-absent");
    }

    #[test]
    fn index_reads_and_writes_share_the_exact_size_limit() {
        let temp = Temp::new();
        temp.write("main.rs", "fn main() {}");
        temp.build();
        let path = index_path(&temp.path, &temp.home());
        let original = fs::read(&path).unwrap();
        let mut bytes = vec![b' '; (MAX_INDEX_BYTES + 1) as usize];
        bytes[..original.len()].copy_from_slice(&original);
        let error = atomic_write(&path, &bytes).unwrap_err().to_string();
        assert!(error.contains("index too large"));
        assert!(error.contains(&(MAX_INDEX_BYTES + 1).to_string()));
        assert!(error.contains("unknown"));
        assert_eq!(fs::read(&path).unwrap(), original);
        let absent = temp.path.join("absent/index.json");
        assert!(atomic_write(&absent, &bytes).is_err());
        assert!(!absent.parent().unwrap().exists());

        atomic_write(&path, &bytes[..MAX_INDEX_BYTES as usize]).unwrap();
        assert!(load_index(&temp.path, &temp.home()).is_some());
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b" ")
            .unwrap();
        assert!(load_index(&temp.path, &temp.home()).is_none());
        dependency_subprocess(&temp, "", "index-absent");
    }

    #[cfg(unix)]
    #[test]
    fn index_reads_reject_symlinks_directories_and_fifos() {
        use std::os::unix::ffi::OsStrExt;
        let temp = Temp::new();
        temp.build();
        let path = index_path(&temp.path, &temp.home());
        let saved = temp.path.join("saved.json");
        fs::rename(&path, &saved).unwrap();
        std::os::unix::fs::symlink(&saved, &path).unwrap();
        assert!(load_index(&temp.path, &temp.home()).is_none());
        dependency_subprocess(&temp, "", "index-absent");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(load_index(&temp.path, &temp.home()).is_none());
        fs::remove_dir(&path).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(load_index(&temp.path, &temp.home()).is_none());
        dependency_subprocess(&temp, "", "index-absent");
    }

    #[cfg(unix)]
    #[test]
    fn source_and_config_links_are_unknown_without_reading_outside_content() {
        let outside = Temp::new();
        outside.write("ignore", "kept.js\n");
        outside.write("module", "module example.com/outside\n");
        outside.write("source", "function outside_only() {}");
        for symlink in [false, true] {
            let temp = Temp::new();
            temp.write("kept.js", "function kept() {}");
            temp.write("src/kept.js", "function nested() {}");
            temp.write(
                "main.go",
                "package main\nimport \"example.com/outside/core\"\n",
            );
            temp.write("core/core.go", "package core\nfunc Work() {}\n");
            for (from, to) in [
                ("ignore", ".gitignore"),
                ("ignore", "src/.gitignore"),
                ("module", "go.mod"),
                ("source", "linked.js"),
            ] {
                let from = outside.path.join(from);
                let to = temp.path.join(to);
                if symlink {
                    std::os::unix::fs::symlink(from, to).unwrap();
                } else {
                    fs::hard_link(from, to).unwrap();
                }
            }
            let (index, _) = temp.build();
            for name in [".gitignore", "src/.gitignore", "go.mod"] {
                assert!(contains(
                    &index.unknown,
                    &format!("unknown: {name} read failed")
                ));
            }
            assert!(index.go_module.is_empty());
            assert!(index.files.contains_key("kept.js"));
            assert!(index.files.contains_key("src/kept.js"));
            assert_eq!(
                index.files["main.go"].imports,
                vec!["raw:example.com/outside/core"]
            );
            assert!(index
                .files
                .values()
                .all(|e| !contains(&e.symbols, "outside_only")));
            if symlink {
                assert!(contains(
                    &index.unknown,
                    "unknown: symlink skipped linked.js"
                ));
            } else {
                assert!(contains(
                    &index.files["linked.js"].unknown,
                    "unknown: source read failed"
                ));
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn incremental_reuse_rejects_new_hardlinks_with_unchanged_size_and_mtime() {
        let temp = Temp::new();
        let outside = Temp::new();
        temp.write("main.js", "function previous() {}");
        let (first, _) = temp.build();
        fs::hard_link(temp.path.join("main.js"), outside.path.join("linked")).unwrap();
        let (next, parsed) = temp.build();
        assert_eq!(parsed, 1);
        assert_eq!(first.files["main.js"].size, next.files["main.js"].size);
        assert_eq!(first.files["main.js"].mtime, next.files["main.js"].mtime);
        assert!(next.files["main.js"].symbols.is_empty());
        assert!(contains(
            &next.files["main.js"].unknown,
            "unknown: source read failed"
        ));
    }

    #[test]
    fn rust_extracts_use_groups_impl_and_tests_without_literal_calls() {
        let source = r###"
            use crate::{alpha::Thing, beta::{helper as renamed, self}};
            mod local;
            struct Thing; enum Mode {} trait Work {} type Alias = Thing; const SIZE: usize = 1;
            impl Work for Thing { fn run(&self) { helper(); self.dynamic(); } }
            #[cfg(test)] mod checks { #[test] fn check() { run(); } }
            // fn phantom() { fake(); } use hidden::x;
            let s = r##"fn hidden() { bogus(); }"##;
            let c = '('; let lifetime: &'static str = "ignored()";
        "###;
        let entry = extract(source, "src/lib.rs", "rs");
        for symbol in ["Thing", "Mode", "Work", "Alias", "SIZE", "run", "check"] {
            assert!(contains(&entry.symbols, symbol), "{symbol}");
        }
        let specs: Vec<_> = entry.import_specs.iter().map(|r| r.spec.clone()).collect();
        for spec in [
            "crate::alpha::Thing",
            "crate::beta::helper",
            "crate::beta",
            "local",
        ] {
            assert!(contains(&specs, spec), "{spec}");
        }
        assert!(contains(&entry.calls, "helper"));
        assert!(contains(&entry.calls, "dynamic"));
        assert!(!contains(&entry.static_calls, "dynamic"));
        for name in ["fake", "bogus", "ignored", "phantom", "hidden"] {
            assert!(!contains(&entry.calls, name));
            assert!(!contains(&entry.symbols, name));
        }
        assert!(entry.tests);
    }

    #[test]
    fn js_extracts_import_require_exports_and_only_top_level_variables() {
        let source = r#"
            import { worker } from "./worker";
            import "side-effects";
            const dependency = require("./legacy"), other = 2;
            export function launch() { const local = 1; worker(); object.method(); }
            export class App {}
            let top = 1; var last = 2;
            // function phantom() { nope(); }
            const text = "function fake() { hidden(); }";
            const template = `ignored()`;
            import(dynamicPath); require(other);
            const rx = /fakeRegex\(\)/;
        "#;
        let entry = extract(source, "app.test.js", "js");
        for symbol in ["dependency", "other", "launch", "App", "top", "last"] {
            assert!(contains(&entry.symbols, symbol), "{symbol}");
        }
        assert!(!contains(&entry.symbols, "local"));
        for symbol in ["phantom", "fake", "hidden", "ignored", "fakeRegex", "nope"] {
            assert!(!contains(&entry.calls, symbol));
            assert!(!contains(&entry.symbols, symbol));
        }
        assert_eq!(
            entry
                .import_specs
                .iter()
                .map(|r| r.spec.as_str())
                .collect::<Vec<_>>(),
            vec!["./legacy", "./worker", "side-effects"]
        );
        assert!(entry.unknown.iter().any(|s| s.contains("dynamic import")));
        assert!(entry.unknown.iter().any(|s| s.contains("dynamic require")));
        assert!(entry.tests);
    }

    #[test]
    fn js_declaration_scan_ignores_delimiters_inside_string_literals() {
        let entry = extract(
            r#"const before = "{", middle = ";", after = 1; const tail = "}";"#,
            "app.js",
            "js",
        );
        for symbol in ["before", "middle", "after", "tail"] {
            assert!(contains(&entry.symbols, symbol), "{symbol}");
        }
    }

    #[test]
    fn python_extracts_imports_classes_async_and_triple_quotes() {
        let source = "import os, package.module as alias\nfrom .helpers import (run, value as v)\nclass Worker:\n    async def launch(self):\n        run()\n        self.dynamic()\n# def fake(): hidden()\ntext = '''def invisible(): bogus()'''\n";
        let entry = extract(source, "test_worker.py", "py");
        assert_eq!(entry.symbols, vec!["Worker", "launch"]);
        for name in ["os", "package.module", ".helpers"] {
            assert!(entry.import_specs.iter().any(|r| r.spec == name));
        }
        assert!(contains(&entry.calls, "run"));
        for name in ["fake", "hidden", "invisible", "bogus"] {
            assert!(!contains(&entry.calls, name));
        }
        assert!(entry.tests);
    }

    #[test]
    fn go_extracts_import_blocks_receiver_methods_types_and_tests() {
        let source = "package demo\nimport (\n \"example.com/demo/core\"\n alias \"fmt\"\n)\ntype Worker struct {}\nfunc (w *Worker) Run() { helper(); w.Method() }\nfunc TestWorker(t *testing.T) {}\n// func Phantom() { nope() }\nvar text = `fake()`\n";
        let entry = extract(source, "worker.go", "go");
        assert_eq!(entry.symbols, vec!["Run", "TestWorker", "Worker"]);
        assert_eq!(entry.import_specs.len(), 2);
        assert!(contains(&entry.calls, "helper"));
        assert!(!contains(&entry.calls, "Run"));
        assert!(!contains(&entry.calls, "fake"));
        assert!(entry.tests);
    }

    #[test]
    fn test_markers_in_comments_and_strings_do_not_mark_tests() {
        let entry = extract(
            "// #[test]\nconst X: &str = \"#[cfg(test)]\"; fn normal() {}",
            "src/normal.rs",
            "rs",
        );
        assert!(!entry.tests);
        assert!(extract("", "tests/unit.rs", "rs").tests);
        assert!(extract("", "thing.spec.tsx", "ts").tests);
        assert!(extract("", "foo_test.rs", "rs").tests);
    }

    #[test]
    fn calls_are_deduplicated_sorted_and_capped_at_200() {
        let source = (0..250)
            .rev()
            .map(|i| format!("call_{i:03}(); call_{i:03}();"))
            .collect::<String>();
        let entry = extract(&source, "main.js", "js");
        assert_eq!(entry.calls.len(), 200);
        assert_eq!(entry.calls.first().unwrap(), "call_000");
        assert_eq!(entry.calls.last().unwrap(), "call_199");
        assert!(entry.unknown.iter().any(|s| s.contains("truncated")));
    }

    #[test]
    fn resolves_rust_crate_self_super_and_module_paths() {
        let temp = Temp::new();
        temp.write(
            "src/lib.rs",
            "mod alpha; mod beta; use crate::alpha::Thing;",
        );
        temp.write("src/alpha.rs", "pub struct Thing;");
        temp.write(
            "src/beta/mod.rs",
            "mod child; use super::alpha::Thing; use self::child::run;",
        );
        temp.write("src/beta/child.rs", "pub fn run() {}");
        let (index, _) = temp.build();
        assert_eq!(
            index.files["src/lib.rs"].imports,
            vec!["src/alpha.rs", "src/beta/mod.rs"]
        );
        assert_eq!(
            index.files["src/beta/mod.rs"].imports,
            vec!["src/alpha.rs", "src/beta/child.rs"]
        );
    }

    #[test]
    fn resolves_js_python_and_go_locally_and_keeps_external_raw() {
        let temp = Temp::new();
        temp.write(
            "app/main.ts",
            "import {work} from './worker.js'; const fs = require('fs');",
        );
        temp.write("app/worker.ts", "export function work() {}");
        temp.write("pkg/__init__.py", "");
        temp.write("pkg/helper.py", "def run(): pass");
        temp.write(
            "pkg/main.py",
            "from . import helper\nimport unknown_package\n",
        );
        temp.write("go.mod", "module example.com/demo\n");
        temp.write("core/core.go", "package core\nfunc Work() {}\n");
        temp.write("core/core_test.go", "package core\nfunc TestWork() {}\n");
        temp.write("pkg/main.go", "package pkg\nimport \"./core\"\n");
        temp.write("pkg/core/core.go", "package core\nfunc Local() {}\n");
        temp.write(
            "main.go",
            "package main\nimport (\"example.com/demo/core\"; \"fmt\")\n",
        );
        let (index, _) = temp.build();
        assert_eq!(
            index.files["app/main.ts"].imports,
            vec!["app/worker.ts", "raw:fs"]
        );
        assert_eq!(
            index.files["pkg/main.py"].imports,
            vec!["pkg/__init__.py", "pkg/helper.py", "raw:unknown_package"]
        );
        assert_eq!(
            index.files["main.go"].imports,
            vec!["core/core.go", "raw:fmt"]
        );
        assert_eq!(index.files["pkg/main.go"].imports, vec!["pkg/core/core.go"]);
    }

    #[test]
    fn index_round_trip_and_root_key_are_stable() {
        let temp = Temp::new();
        temp.write("src/main.rs", "fn main() { work(); }");
        let (index, _) = temp.build();
        let loaded = load_index(&temp.path, &temp.home()).unwrap();
        assert_eq!(index, loaded);
        assert_eq!(
            Index::from_value(&index.value(), &temp.path).unwrap(),
            index
        );
        let path = index_path(&temp.path, &temp.home());
        assert_eq!(path.file_stem().unwrap().to_str().unwrap().len(), 16);
        assert_eq!(index.value()["schema"], 1);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn unchanged_entries_are_not_reparsed_and_force_reparses() {
        let temp = Temp::new();
        temp.write("a.rs", "fn a() {}");
        temp.write("b.rs", "fn b() {}");
        let (first, parsed) = temp.build();
        assert_eq!(parsed, 2);
        let (second, parsed) = temp.build();
        assert_eq!(parsed, 0);
        assert_eq!(first, second);
        temp.write("b.rs", "fn changed_name() {}");
        let (changed, parsed) = temp.build();
        assert_eq!(parsed, 1);
        assert_eq!(first.files["a.rs"], changed.files["a.rs"]);
        assert!(contains(&changed.files["b.rs"].symbols, "changed_name"));
        assert_eq!(build_index(&temp.path, &temp.home(), true).unwrap().1, 2);
    }

    #[test]
    fn corruption_and_unknown_schema_rebuild_without_failure() {
        let temp = Temp::new();
        temp.write("a.rs", "fn a() {}");
        let (index, _) = temp.build();
        let path = index_path(&temp.path, &temp.home());
        fs::write(&path, b"{broken").unwrap();
        assert!(load_index(&temp.path, &temp.home()).is_none());
        assert_eq!(temp.build().1, 1);
        let mut wrong = index.value();
        wrong["schema"] = json!(999);
        fs::write(&path, wrong.to_string()).unwrap();
        assert!(load_index(&temp.path, &temp.home()).is_none());
        assert_eq!(temp.build().1, 1);
    }

    fn impact_repo(temp: &Temp) {
        temp.write("src/base.js", "export function leaf() {}");
        temp.write(
            "src/middle.js",
            "import {leaf} from './base'; export function middle() { leaf(); }",
        );
        temp.write(
            "src/top.js",
            "import {middle} from './middle'; export function top() { middle(); }",
        );
        temp.write(
            "tests/flow.test.js",
            "import {top} from '../src/top'; top();",
        );
    }

    #[test]
    fn impact_closure_depth_and_affected_tests() {
        let temp = Temp::new();
        impact_repo(&temp);
        let (index, _) = temp.build();
        let impact = impact_value(&index, "src/base.js", 3, false);
        assert_eq!(impact["kind"], "file");
        assert_eq!(impact["direct"], json!(["src/middle.js"]));
        assert_eq!(
            impact["transitive"],
            json!(["src/top.js", "tests/flow.test.js"])
        );
        assert_eq!(impact["tests"], json!(["tests/flow.test.js"]));
        let shallow = impact_value(&index, "leaf", 1, false);
        assert_eq!(shallow["kind"], "symbol");
        assert_eq!(shallow["direct"], json!(["src/middle.js"]));
        assert_eq!(shallow["transitive"], json!([]));
        assert_eq!(impact_value(&index, "leaf", 99, false)["depth"], 8);
    }

    #[test]
    fn cycles_do_not_repeat_seeds_or_direct_nodes() {
        let temp = Temp::new();
        temp.write("a.js", "import './b';");
        temp.write("b.js", "import './a';");
        temp.write("c.js", "import './b';");
        let (index, _) = temp.build();
        let impact = impact_value(&index, "a.js", 8, false);
        assert_eq!(impact["direct"], json!(["b.js"]));
        assert_eq!(impact["transitive"], json!(["c.js"]));
    }

    #[test]
    fn unknown_targets_and_queries_offer_candidates() {
        let temp = Temp::new();
        impact_repo(&temp);
        let (index, _) = temp.build();
        let impact = impact_value(&index, "missing", 3, false);
        assert_eq!(impact["status"], "unknown");
        assert_eq!(impact["direct"], json!([]));
        assert!(!impact["candidates"].as_array().unwrap().is_empty());
        let found = query_value(&index, "leaf");
        assert_eq!(found["definitions"], json!(["src/base.js"]));
        assert_eq!(found["references"], json!(["src/middle.js"]));
        assert_eq!(query_value(&index, "absent")["found"], false);
    }

    #[test]
    fn json_is_identical_for_repeated_incremental_and_forced_builds() {
        let temp = Temp::new();
        impact_repo(&temp);
        let (first, _) = temp.build();
        let first_bytes = fs::read(index_path(&temp.path, &temp.home())).unwrap();
        let (second, _) = temp.build();
        assert_eq!(first.value().to_string(), second.value().to_string());
        assert_eq!(
            first_bytes,
            fs::read(index_path(&temp.path, &temp.home())).unwrap()
        );
        let (forced, _) = build_index(&temp.path, &temp.home(), true).unwrap();
        assert_eq!(
            first_bytes,
            fs::read(index_path(&temp.path, &temp.home())).unwrap()
        );
        assert_eq!(
            impact_value(&first, "leaf", 3, false).to_string(),
            impact_value(&forced, "leaf", 3, false).to_string()
        );
        assert_eq!(query_value(&first, "leaf"), query_value(&second, "leaf"));
    }

    #[test]
    fn neighbours_are_import_only_sorted_bounded_and_exclude_seeds() {
        let temp = Temp::new();
        impact_repo(&temp);
        let (index, _) = temp.build();
        assert_eq!(
            neighbours(&index, &["src/middle.js".into()], 5),
            vec!["src/base.js", "src/top.js"]
        );
        assert_eq!(
            neighbours(&index, &["src/middle.js".into()], 1),
            vec!["src/base.js"]
        );
        assert!(neighbours(&index, &["missing.js".into()], 5).is_empty());
        assert!(load_index(&temp.path, &temp.path.join("absent-home")).is_none());
        assert!(related_at(
            &temp.path,
            &temp.path.join("absent-home"),
            &["src/base.js".into()],
            5
        )
        .is_empty());
    }

    #[test]
    fn respects_ignore_rules_nested_negation_and_build_directory_skips() {
        let temp = Temp::new();
        temp.write(
            ".gitignore",
            "ignored/\n*.skip.js\n!keep.skip.js\n/rootonly.js\n",
        );
        for path in [
            "ignored/no.rs",
            "target/no.rs",
            "node_modules/no.js",
            "rootonly.js",
            "no.skip.js",
            "keep.skip.js",
            "src/rootonly.js",
            "src/good.rs",
        ] {
            temp.write(path, "");
        }
        temp.write("src/.gitignore", "nested.py\n");
        temp.write("src/nested.py", "");
        let (index, _) = temp.build();
        assert_eq!(
            index.files.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["keep.skip.js", "src/good.rs", "src/rootonly.js"]
        );
    }

    #[test]
    fn sources_are_bounded_and_deleted_files_leave_index() {
        let temp = Temp::new();
        temp.write(
            "big.js",
            &format!(
                "{}\nfunction beyond_limit() {{}}",
                " ".repeat(MAX_BYTES as usize)
            ),
        );
        temp.write("gone.rs", "fn gone() {}");
        let (index, _) = temp.build();
        assert!(index.files["big.js"].truncated);
        assert!(!contains(&index.files["big.js"].symbols, "beyond_limit"));
        assert!(Graph::new(&index).unresolved > 0);
        fs::remove_file(temp.path.join("gone.rs")).unwrap();
        assert!(stale(&index, &temp.path));
        let (next, parsed) = temp.build();
        assert_eq!(parsed, 0);
        assert!(!next.files.contains_key("gone.rs"));
    }

    #[test]
    fn new_import_targets_are_resolved_even_when_importer_is_reused() {
        let temp = Temp::new();
        temp.write("main.js", "import './later';");
        let (first, _) = temp.build();
        assert_eq!(first.files["main.js"].imports, vec!["raw:./later"]);
        temp.write("later.js", "export function work() {}");
        let (second, parsed) = temp.build();
        assert_eq!(parsed, 1);
        assert_eq!(second.files["main.js"].imports, vec!["later.js"]);
    }

    #[test]
    fn dynamic_calls_and_ambiguous_imports_are_unresolved() {
        let temp = Temp::new();
        temp.write(
            "main.js",
            "import './same'; object.hidden(); unknown(); import(path);",
        );
        temp.write("same.js", "function hidden() {}");
        temp.write("same.ts", "function hidden() {}");
        let (index, _) = temp.build();
        assert_eq!(index.files["main.js"].imports, vec!["raw:./same"]);
        assert!(Graph::new(&index).unresolved >= 4);
        assert_eq!(
            impact_value(&index, "same.js", 3, false)["direct"],
            json!([])
        );
    }

    #[test]
    fn wildcard_double_star_matches_zero_and_many_directories() {
        for path in ["a/b.js", "a/nested/b.js", "a/deep/nested/b.js"] {
            assert!(wildcard(b"a/**/b.js", path.as_bytes()), "{path}");
        }
        assert!(wildcard(b"**/*.rs", b"main.rs"));
        assert!(wildcard(b"**/*.rs", b"src/main.rs"));
        assert!(!wildcard(b"src/*.rs", b"src/deep/main.rs"));
        assert!(wildcard(b"src/?.rs", b"src/a.rs"));
    }

    #[test]
    fn go_module_changes_invalidate_resolution_without_reparsing_sources() {
        let temp = Temp::new();
        temp.write("go.mod", "module example.com/old\n");
        temp.write("main.go", "package main\nimport \"example.com/old/core\"\n");
        temp.write("core/core.go", "package core\nfunc Run() {}\n");
        let (first, _) = temp.build();
        assert_eq!(first.files["main.go"].imports, vec!["core/core.go"]);
        temp.write("go.mod", "module example.com/new\n");
        assert!(stale(&first, &temp.path));
        let (second, parsed) = temp.build();
        assert_eq!(parsed, 0);
        assert_eq!(
            second.files["main.go"].imports,
            vec!["raw:example.com/old/core"]
        );
    }

    #[test]
    fn rust_inline_module_paths_and_test_crate_roots_resolve() {
        let temp = Temp::new();
        temp.write(
            "crates/demo/src/lib.rs",
            "mod outer { mod child; use self::child::run; }\n",
        );
        temp.write("crates/demo/src/outer/child.rs", "pub fn run() {}\n");
        temp.write(
            "crates/demo/tests/check.rs",
            "use crate::outer::child::run; #[cfg(\n test\n)] fn check() { run(); }\n",
        );
        let (index, _) = temp.build();
        assert_eq!(
            index.files["crates/demo/src/lib.rs"].imports,
            vec!["crates/demo/src/outer/child.rs"]
        );
        assert_eq!(
            index.files["crates/demo/tests/check.rs"].imports,
            vec!["crates/demo/src/outer/child.rs"]
        );
        assert!(index.files["crates/demo/tests/check.rs"].tests);
    }

    #[test]
    fn corrupt_stats_are_not_trusted() {
        let temp = Temp::new();
        temp.write("main.rs", "fn main() {}\n");
        let (index, _) = temp.build();
        let mut value = index.value();
        value["stats"]["files"] = json!(500);
        assert!(Index::from_value(&value, &temp.path).is_none());
    }

    #[test]
    fn macros_generated_code_and_indirect_calls_are_explicitly_unknown() {
        let rust = extract(
            "// Code generated. DO NOT EDIT.\nfn run() { invoke!(); (*callback)(); }",
            "generated.rs",
            "rs",
        );
        for reason in ["generated code", "macro invoke", "indirect invocation"] {
            assert!(rust.unknown.iter().any(|s| s.contains(reason)), "{reason}");
        }
        let js = extract("const value = `${callback()}`; (callback)();", "a.js", "js");
        assert!(!contains(&js.calls, "callback"));
        assert!(js
            .unknown
            .iter()
            .any(|s| s.contains("template interpolation")));
        assert!(js.unknown.iter().any(|s| s.contains("indirect invocation")));
    }

    #[test]
    fn unique_same_language_calls_are_potential_edges_with_unknown_bindings() {
        let temp = Temp::new();
        temp.write("src/core.rs", "pub fn run() {}\n");
        temp.write(
            "tests/caller.rs",
            "use fixture::run; #[test] fn check() { run(); }\n",
        );
        temp.write("unrelated.py", "def check(): run()\n");
        let (index, _) = temp.build();
        let impact = impact_value(&index, "src/core.rs", 3, false);
        assert_eq!(impact["direct"], json!(["tests/caller.rs"]));
        assert_eq!(impact["tests"], json!(["tests/caller.rs"]));
        assert!(Graph::new(&index).unresolved >= 2);
    }

    #[test]
    fn go_grouped_types_are_definitions_but_struct_fields_are_not() {
        let entry = extract(
            "package demo\ntype (\nA string\nB struct {\nField int\n}\nC = A\n)\n",
            "a.go",
            "go",
        );
        assert_eq!(entry.symbols, vec!["A", "B", "C"]);
    }

    #[test]
    fn rust_const_functions_and_mutable_statics_use_the_declared_name() {
        let entry = extract(
            "pub const fn value() -> u32 { 1 } static mut COUNT: u32 = 0;",
            "a.rs",
            "rs",
        );
        assert_eq!(entry.symbols, vec!["COUNT", "value"]);
        assert!(entry.calls.is_empty());
    }
}
