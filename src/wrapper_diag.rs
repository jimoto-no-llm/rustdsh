use crate::{executable, locale};

/// Text wrappers and dangling links kept from one bounded pass over the local
/// bin dir, shared by the wrapper checks so `doctor` never reads it twice.
struct WrapperScan {
    texts: Vec<(String, String)>,
    broken_links: Vec<(String, String)>,
    non_executable: Vec<String>,
}

/// Bounds for the wrapper-dir pass and the PATH probes below: `doctor` is a
/// diagnostic and must stay fast even when the bin dir is unusual.
const WRAPPER_DIR_MAX_ENTRIES: usize = 256;
const WRAPPER_TEXT_MAX_BYTES: u64 = 65536;
const WRAPPER_TEXT_MAX_FILES: usize = 64;
const WRAPPER_WARN_MAX: usize = 10;
const PATH_SCAN_MAX_DIRS: usize = 64;

/// Wrapper dir used by the installers: ~/.local/bin on Unix and
/// %LOCALAPPDATA%\rdsh\bin on Windows. PATH is not scanned: a checkout
/// target dir or /usr/bin would only add noise.
#[cfg(not(windows))]
fn local_bin_dir() -> Option<std::path::PathBuf> {
    let home = crate::inspect::home_dir()?;
    Some(std::path::Path::new(&home).join(".local").join("bin"))
}

#[cfg(windows)]
fn local_bin_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("rdsh").join("bin"))
}

/// One bounded pass over the wrapper dir. Size-gate before reading: the dir can
/// hold huge binaries and reading them fully just to discard costs seconds in
/// doctor.
fn scan_local_wrappers(dir: &std::path::Path) -> WrapperScan {
    let mut scan = WrapperScan {
        texts: Vec::new(),
        broken_links: Vec::new(),
        non_executable: Vec::new(),
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return scan;
    };
    for entry in entries.flatten().take(WRAPPER_DIR_MAX_ENTRIES) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = entry.path();
        // Symlink first: a dangling link looks absent to metadata()/is_file().
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink())
            && std::fs::metadata(&path).is_err()
        {
            let target = std::fs::read_link(&path)
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "<unreadable>".to_string());
            scan.broken_links.push((name, target));
            continue;
        }
        if scan.texts.len() >= WRAPPER_TEXT_MAX_FILES || !path.is_file() {
            continue;
        }
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > WRAPPER_TEXT_MAX_BYTES) {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap_or_default();
        if bytes.len() as u64 > WRAPPER_TEXT_MAX_BYTES || bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        #[cfg(unix)]
        if name.contains("dsh")
            && (text.starts_with("#!") || text.contains("exec "))
            && !is_executable_file(&path)
        {
            scan.non_executable.push(name.clone());
        }
        scan.texts.push((name, text));
    }
    scan
}

/// Wrappers that run `node` on the `dsh` path break once `dsh` is shadowed by
/// the native binary (Node tries to parse the ELF as JS). Point at the
/// offending wrappers found by the shared scan. `skip` names the files the
/// broken-wrapper check already reported, so one file never yields two lines.
fn node_wrapper_warnings(
    scan: &WrapperScan,
    dir: &std::path::Path,
    shadowed: bool,
    skip: &[&str],
    locale: locale::Locale,
) -> Vec<String> {
    let mut hits: Vec<String> = scan
        .texts
        .iter()
        .filter(|(name, text)| {
            let tokens = text.lines().filter_map(shell_words);
            let mut has_node = false;
            let mut has_dsh = false;
            for line in tokens {
                for token in line {
                    let base = token.rsplit(['/', '\\']).next().unwrap_or_default();
                    has_node |= base == "node" || base == "node.exe";
                    // An explicit `node /path/to/dsh/index.js` entry does not
                    // resolve the `dsh` command, so shadowing cannot break it.
                    // docs/DOCTOR.md promises exactly this exclusion. Do not
                    // require a `/`: shell_words drops the backslashes inside
                    // a quoted Windows path, so the separator is gone by now.
                    let explicit_js_entry = token.ends_with(".js");
                    has_dsh |= token.contains("dsh") && !explicit_js_entry;
                }
            }
            has_node && has_dsh && !skip.contains(&name.as_str())
        })
        .map(|(name, _)| name.clone())
        .collect();
    hits.sort();
    hits.truncate(WRAPPER_WARN_MAX);
    hits.into_iter()
        .map(|name| {
            let wrapper = dir.join(&name).display().to_string();
            if shadowed {
                localized_format!(locale, "[rdsh] warn: {wrapper} calls `node` on a dsh path; while `dsh` is shadowed that path is a native binary — exec `dsh`/`rdsh` directly instead of via `node`", "[rdsh] 警告：{wrapper} 通过 `node` 调用 dsh 路径；当前 dsh 被遮蔽，该路径是原生程序。请直接执行 `dsh`/`rdsh`", "[rdsh] 警告: {wrapper} は dsh パスを `node` で呼び出します。現在はネイティブバイナリなので `dsh`/`rdsh` を直接実行してください")
            } else {
                localized_format!(locale, "[rdsh] note: {wrapper} calls `node` on a dsh path; it will break if `dsh` is later shadowed — exec `dsh`/`rdsh` directly instead of via `node`", "[rdsh] 提示：{wrapper} 通过 `node` 调用 dsh 路径；以后遮蔽 dsh 会失败。请直接执行 `dsh`/`rdsh`", "[rdsh] 注記: {wrapper} は dsh パスを `node` で呼び出します。後で dsh が隠蔽されると失敗するため `dsh`/`rdsh` を直接実行してください")
            }
        })
        .collect()
}

/// Split the simple shell-like syntax used by wrapper lines while preserving
/// quoted paths. An unmatched quote is unknown and is left undiagnosed.
fn shell_words(line: &str) -> Option<Vec<String>> {
    #[derive(Clone, Copy)]
    enum Quote {
        Single,
        Double,
    }

    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut active = false;
    for character in line.chars() {
        if escaped {
            word.push(character);
            active = true;
            escaped = false;
            continue;
        }
        match quote {
            Some(Quote::Single) if character == char::from(39) => quote = None,
            Some(Quote::Single) => word.push(character),
            Some(Quote::Double) if character == '"' => quote = None,
            Some(Quote::Double) if character == char::from(92) => escaped = true,
            Some(Quote::Double) => word.push(character),
            None if character == '#' && !active => break,
            None if character == char::from(92) => {
                escaped = true;
                active = true;
            }
            None if character == char::from(39) => {
                quote = Some(Quote::Single);
                active = true;
            }
            None if character == '"' => {
                quote = Some(Quote::Double);
                active = true;
            }
            None if character.is_whitespace()
                || matches!(
                    character,
                    ';' | '|' | '&' | '(' | ')' | '{' | '}' | '<' | '>'
                ) =>
            {
                if active {
                    words.push(std::mem::take(&mut word));
                    active = false;
                }
            }
            None => {
                word.push(character);
                active = true;
            }
        }
    }
    if escaped || quote.is_some() {
        return None;
    }
    if active {
        words.push(word);
    }
    Some(words)
}

fn env_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

/// Interpreter a shebang needs at run time. env's split-string mode supports
/// options and assignments before the command; unsupported forms are unknown,
/// so doctor leaves them alone instead of reporting a false missing program.
fn shebang_interpreter(line: &str) -> Option<String> {
    let content = line.trim_start().strip_prefix("#!")?;
    let tokens = shell_words(content)?;
    let program = tokens.first()?;
    if program != "env" && !program.ends_with("/env") {
        return Some(program.clone());
    }
    let arguments = &tokens[1..];
    let split = matches!(
        arguments.first().map(String::as_str),
        Some("-S" | "--split-string")
    );
    if !split {
        let command = arguments.first()?;
        return (!command.starts_with('-') && !env_assignment(command)).then(|| command.clone());
    }

    let mut index = 1;
    while let Some(argument) = arguments.get(index) {
        match argument.as_str() {
            "--" => {
                index += 1;
                break;
            }
            "-i" | "--ignore-environment" => index += 1,
            "-u" | "--unset" | "-C" | "--chdir" => {
                arguments.get(index + 1)?;
                index += 2;
            }
            value if value.starts_with("--unset=") || value.starts_with("--chdir=") => index += 1,
            value if value.starts_with('-') => return None,
            value if env_assignment(value) => index += 1,
            value => return Some(value.to_string()),
        }
    }
    arguments
        .get(index)
        .cloned()
        .filter(|value| !value.starts_with('-'))
}

/// Absolute node/dsh/rdsh paths a wrapper passes around, e.g.
/// exec /opt/node/bin/node /opt/dsh/lib/bin.js. Only program-shaped tokens
/// count and comments are skipped, so unrelated absolute paths (PATH=...,
/// log files, notes about old locations) stay quiet.
fn referenced_binary_paths(text: &str) -> Vec<String> {
    const PROGRAMS: &[&str] = &[
        "node",
        "node.exe",
        "dsh",
        "dsh.exe",
        "rdsh",
        "rdsh.exe",
        "dsh-orig",
        "dsh-orig.exe",
        "dsh.orig",
        "dsh.real",
    ];
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some(tokens) = shell_words(line) else {
            continue;
        };
        for token in tokens {
            // Unix absolute paths only: Windows path syntax is never parsed from
            // wrapper text (the executability probe covers native installs).
            if !token.starts_with('/') {
                continue;
            }
            let base = token.rsplit('/').next().unwrap_or_default();
            let program_like = PROGRAMS.contains(&base)
                || (base.ends_with(".js") && token.split('/').any(|part| part == "dsh"));
            if program_like && !out.iter().any(|seen| seen == &token) {
                out.push(token);
            }
            if out.len() >= 8 {
                return out;
            }
        }
    }
    out
}

/// Read-only executable probe matching passthrough's is_executable_candidate:
/// mode bits owned by another permission class must not count.
fn is_executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: c_path is NUL-terminated and AT_FDCWD keeps this read-only.
        unsafe {
            libc::faccessat(
                libc::AT_FDCWD,
                c_path.as_ptr(),
                libc::X_OK,
                libc::AT_EACCESS,
            ) == 0
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// A .js entrypoint only has to exist (Node runs it); anything else must be
/// executable. Mirrors passthrough's runnable-original rule.
fn usable_original(path: &std::path::Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "js") {
        path.is_file()
    } else {
        is_executable_file(path)
    }
}

/// First executable name on PATH, bounded by PATH_SCAN_MAX_DIRS. An absolute
/// name is checked directly, so a shebang like #!/bin/sh works too.
fn command_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    command_on_path_in(name, &path_var)
}

/// Resolve a command without running it. Match Command::new's PATH behavior
/// closely enough for diagnostics, including the Windows .exe convention.
fn command_on_path_in(name: &str, path_var: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(name);
    let has_separator = name.contains('/') || (cfg!(windows) && name.contains('\\'));
    if path.is_absolute() || has_separator {
        if is_executable_file(path) {
            return Some(path.to_path_buf());
        }
        #[cfg(windows)]
        if path.extension().is_none() {
            let with_exe = path.with_extension("exe");
            if is_executable_file(&with_exe) {
                return Some(with_exe);
            }
        }
        return None;
    }

    #[cfg(windows)]
    let executable_name = if path.extension().is_none() {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    #[cfg(not(windows))]
    let executable_name = name.to_string();

    let directories: Vec<std::path::PathBuf> = std::env::split_paths(path_var)
        .take(PATH_SCAN_MAX_DIRS)
        .collect();
    #[cfg(windows)]
    let directories = {
        let mut directories = directories;
        if let Ok(executable) = std::env::current_exe() {
            if let Some(parent) = executable.parent() {
                directories.push(parent.to_path_buf());
            }
        }
        if let Some(root) = std::env::var_os("SystemRoot").map(std::path::PathBuf::from) {
            directories.push(root.join("System32"));
            directories.push(root);
        }
        directories
    };
    directories
        .into_iter()
        .take(PATH_SCAN_MAX_DIRS)
        .map(|directory| directory.join(&executable_name))
        .find(|candidate| is_executable_file(candidate))
}

/// Why one wrapper in the local bin dir cannot run, if the scan can tell. Only
/// the first problem is reported: one line per file.
fn broken_wrapper_reason(
    dir: &std::path::Path,
    name: &str,
    text: &str,
    locale: locale::Locale,
) -> Option<String> {
    let wrapper = dir.join(name).display().to_string();
    if let Some(line) = text.lines().next().filter(|line| line.starts_with("#!")) {
        if let Some(interp) = shebang_interpreter(line) {
            if command_on_path(&interp).is_none() {
                return Some(localized_format!(locale, "[rdsh] warn: {wrapper} needs '{interp}' on PATH, which is missing; the wrapper cannot run", "[rdsh] 警告：{wrapper} 需要 PATH 中的 '{interp}'，但未找到；包装程序无法运行", "[rdsh] 警告: {wrapper} に必要な '{interp}' がPATHにありません。ラッパーを実行できません"
                ));
            }
        }
    }
    for p in referenced_binary_paths(text) {
        let path = std::path::Path::new(&p);
        if usable_original(path) {
            continue;
        }
        let why = if path.exists() {
            locale::diagnostic(locale, "is not executable")
        } else {
            locale::diagnostic(locale, "does not exist")
        };
        return Some(localized_format!(locale, "[rdsh] warn: {wrapper} references {p}, which {why}; fix the path or reinstall the wrapper", "[rdsh] 警告：{wrapper} 引用的 {p} {why}；请修正路径或重新安装包装程序", "[rdsh] 警告: {wrapper} の参照先 {p} は{why}。パスを修正するかラッパーを再インストールしてください"
        ));
    }
    None
}

/// Broken wrappers found by the shared scan: dangling dsh/rdsh symlinks, a
/// missing shebang interpreter, or an absolute node/dsh/rdsh path that is
/// gone. Advisory only, one line per file, returned as (name, warning) so the
/// node-on-dsh check can skip what is already reported.
fn broken_wrapper_warnings(
    scan: &WrapperScan,
    dir: &std::path::Path,
    locale: locale::Locale,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, target) in &scan.broken_links {
        if !name.contains("dsh") || out.len() >= WRAPPER_WARN_MAX {
            continue;
        }
        let wrapper = dir.join(name).display().to_string();
        out.push((
            name.clone(),
            localized_format!(
                locale,
                "[rdsh] warn: {wrapper} is a broken symlink -> {target}; recreate or remove it",
                "[rdsh] 警告：{wrapper} 是失效的符号链接 -> {target}；请重新创建或移除",
                "[rdsh] 警告: {wrapper} はリンク切れです -> {target}。再作成または削除してください"
            ),
        ));
    }
    for name in &scan.non_executable {
        if out.len() >= WRAPPER_WARN_MAX {
            break;
        }
        if name.contains("dsh") {
            let wrapper = dir.join(name).display().to_string();
            out.push((
                name.clone(),
                localized_format!(
                    locale,
                    "[rdsh] warn: {wrapper} is not executable; the wrapper cannot run",
                    "[rdsh] 警告：{wrapper} 不可执行；包装程序无法运行",
                    "[rdsh] 警告: {wrapper} に実行権限がありません。ラッパーを実行できません"
                ),
            ));
        }
    }
    for (name, text) in &scan.texts {
        if out.len() >= WRAPPER_WARN_MAX {
            break;
        }
        if scan.non_executable.contains(name) || !(name.contains("dsh") || text.contains("dsh")) {
            continue;
        }
        if let Some(warning) = broken_wrapper_reason(dir, name, text, locale) {
            out.push((name.clone(), warning));
        }
    }
    out
}

/// Every wrapper warning, from one bounded pass over the wrapper dir. A file
/// with a concrete broken path keeps that finding instead of the generic
/// node-on-dsh note.
pub(crate) fn wrapper_warnings(shadowed: bool, locale: locale::Locale) -> Vec<String> {
    let Some(dir) = local_bin_dir() else {
        return Vec::new();
    };
    let scan = scan_local_wrappers(&dir);
    let broken = broken_wrapper_warnings(&scan, &dir, locale);
    let broken_names: Vec<String> = broken.iter().map(|(name, _)| name.clone()).collect();
    let mut out: Vec<String> = broken.into_iter().map(|(_, warning)| warning).collect();
    let skip: Vec<&str> = broken_names.iter().map(String::as_str).collect();
    out.extend(node_wrapper_warnings(&scan, &dir, shadowed, &skip, locale));
    out
}

/// Shadowing and install-ledger diagnostics: warnings only, so doctor keeps
/// its exit status (only the missing original at the end is fatal).
pub(crate) fn shadow_warnings(
    shadowed: bool,
    orig: Option<&str>,
    locale: locale::Locale,
) -> Vec<String> {
    let mut out = duplicate_path_warnings(locale);
    out.extend(original_override_warnings(locale));
    out.extend(origin_ledger_warnings(orig, locale));
    if shadowed {
        if let Some(dir) = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .ok()
            .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        {
            out.extend(shadow_backup_warnings(&dir, orig, locale));
        }
    }
    out
}

/// PATH entries holding an executable base name (dsh/rdsh), in resolution
/// order, deduplicated by canonical path and bounded by PATH_SCAN_MAX_DIRS.
fn path_binary_hits_in(path_var: &std::ffi::OsStr, base: &str) -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    let names = [format!("{base}.exe"), base.to_string()];
    #[cfg(not(windows))]
    let names = [base.to_string()];

    let mut hits: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: Vec<std::path::PathBuf> = Vec::new();
    for dir in std::env::split_paths(path_var).take(PATH_SCAN_MAX_DIRS) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in &names {
            let candidate = dir.join(name);
            if !is_executable_file(&candidate) {
                continue;
            }
            let key = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            hits.push(candidate);
            break;
        }
    }
    hits
}

/// Report dsh/rdsh resolving to more than one PATH entry: whichever comes
/// first wins, so a stale copy earlier in PATH silently shadows the real one.
fn duplicate_path_warnings(locale: locale::Locale) -> Vec<String> {
    let Some(path_var) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for base in ["dsh", "rdsh"] {
        let hits = path_binary_hits_in(&path_var, base);
        if hits.len() < 2 {
            continue;
        }
        let listed: Vec<String> = hits
            .iter()
            .take(4)
            .map(|p| p.display().to_string())
            .collect();
        let extra = hits.len() - listed.len();
        let extra = if extra > 0 {
            localized_format!(
                locale,
                " (+{extra} more)",
                "（另有 {extra} 个）",
                "（ほか{extra}件）"
            )
        } else {
            String::new()
        };
        out.push(localized_format!(
            locale,
            "[rdsh] note: {} '{base}' entries on PATH: {}{extra}; the first one wins",
            "[rdsh] 提示：PATH 中有 {} 个 '{base}'：{}{extra}；使用第一个",
            "[rdsh] 注記: PATHに '{base}' が{}件あります: {}{extra}。最初のものを使用します",
            hits.len(),
            listed.join(", ")
        ));
    }
    out
}

/// The env override wins over every other original resolution and is taken
/// as-is (find_original_dsh does not validate it), so a typo there breaks
/// delegation while doctor still prints the path.
fn original_override_warnings(locale: locale::Locale) -> Vec<String> {
    for key in ["RDSH_ORIG_BIN", "DSH_ORIG_BIN"] {
        let Ok(value) = std::env::var(key) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let path_var = std::env::var_os("PATH").unwrap_or_default();
        let path = std::path::Path::new(&value);
        // `passthrough` sends `.js` overrides to Node as a file argument,
        // which resolves relative to CWD and does not search PATH.
        let node_entrypoint = path.extension().is_some_and(|ext| ext == "js");
        let explicit_path = value.contains('/') || (cfg!(windows) && value.contains('\\'));
        let usable = if node_entrypoint || explicit_path {
            usable_original(path)
        } else {
            command_on_path_in(&value, &path_var).is_some()
        };
        if usable {
            return Vec::new();
        }
        return vec![localized_format!(locale, "[rdsh] warn: {key}={value} is not a usable dsh entrypoint; passthrough takes the override as-is, so delegation will fail", "[rdsh] 警告：{key}={value} 不是可用的 dsh 入口；passthrough 原样使用此覆盖值，委托将失败", "[rdsh] 警告: {key}={value} は使用可能なdsh起動先ではありません。passthroughは指定値をそのまま使うため、委譲に失敗します"
        )];
    }
    Vec::new()
}

/// install.sh --as-dsh records the backup it moved aside in
/// ~/.config/rdsh/origin, and passthrough prefers that path. A stale entry is
/// easy to miss because the failure looks like an ordinary delegation error.
fn origin_ledger_warnings_in(
    ledger: &std::path::Path,
    orig: Option<&str>,
    locale: locale::Locale,
) -> Vec<String> {
    let Ok(metadata) = std::fs::metadata(ledger) else {
        return Vec::new();
    };
    // One path line: keep the read bounded even if the file was replaced.
    if !metadata.is_file() || metadata.len() > 4096 {
        return Vec::new();
    }
    let Ok(recorded) = std::fs::read_to_string(ledger) else {
        return Vec::new();
    };
    let recorded = recorded.trim();
    if recorded.is_empty() {
        return Vec::new();
    }
    let path = std::path::Path::new(recorded);
    if !path.exists() {
        return vec![localized_format!(locale, "[rdsh] warn: install ledger {} records {recorded}, which no longer exists; run install.sh --restore or remove the file", "[rdsh] 警告：安装记录 {} 中的 {recorded} 已不存在；请运行 install.sh --restore 或移除该记录文件", "[rdsh] 警告: インストール記録 {} の {recorded} が存在しません。install.sh --restore を実行するか記録ファイルを削除してください",
            ledger.display()
        )];
    }
    if !usable_original(path) {
        return vec![localized_format!(locale, "[rdsh] warn: install ledger {} records {recorded}, which is not executable; passthrough ignores it", "[rdsh] 警告：安装记录 {} 中的 {recorded} 不可执行；passthrough 将忽略它", "[rdsh] 警告: インストール記録 {} の {recorded} に実行権限がありません。passthroughは使用しません",
            ledger.display()
        )];
    }
    if orig != Some(recorded) {
        return vec![localized_format!(locale, "[rdsh] note: install ledger records {recorded}, but passthrough resolves {} (RDSH_ORIG_BIN/DSH_ORIG_BIN wins over the ledger)", "[rdsh] 提示：安装记录为 {recorded}，但 passthrough 使用 {}（RDSH_ORIG_BIN/DSH_ORIG_BIN 优先于安装记录）", "[rdsh] 注記: インストール記録は {recorded} ですが、passthroughは {} を使用します（RDSH_ORIG_BIN/DSH_ORIG_BINが優先）",
            orig.unwrap_or("<not found>")
        )];
    }
    Vec::new()
}

fn origin_ledger_warnings(orig: Option<&str>, locale: locale::Locale) -> Vec<String> {
    let Some(home) = crate::inspect::home_dir() else {
        return Vec::new();
    };
    let ledger = std::path::Path::new(&home)
        .join(".config")
        .join("rdsh")
        .join("origin");
    origin_ledger_warnings_in(&ledger, orig, locale)
}

/// install.sh --as-dsh parks the original next to the shadowing binary as
/// dsh-orig, and --restore needs that file. dir is the directory of the
/// running binary, i.e. the install prefix in the shadowed layout.
fn shadow_backup_warnings(
    dir: &std::path::Path,
    orig: Option<&str>,
    locale: locale::Locale,
) -> Vec<String> {
    #[cfg(windows)]
    const BACKUPS: &[&str] = &["dsh-orig.exe", "dsh-orig", "dsh.orig", "dsh.real"];
    #[cfg(not(windows))]
    const BACKUPS: &[&str] = &["dsh-orig", "dsh.orig", "dsh.real"];

    let mut unrunnable: Option<std::path::PathBuf> = None;
    for name in BACKUPS {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Vec::new();
        }
        if unrunnable.is_none() && candidate.exists() {
            unrunnable = Some(candidate);
        }
    }
    let fallback = orig.unwrap_or("<not found>");
    if let Some(candidate) = unrunnable {
        return vec![localized_format!(locale, "[rdsh] warn: {} exists but is not executable, so shadowed 'dsh' cannot delegate through it; passthrough falls back to {fallback}", "[rdsh] 警告：{} 存在但不可执行，被遮蔽的 'dsh' 无法通过它委托；passthrough 回退到 {fallback}", "[rdsh] 警告: {} は存在しますが実行できず、隠蔽された 'dsh' の委譲先にできません。passthroughは {fallback} を使用します",
            candidate.display()
        )];
    }
    vec![localized_format!(locale, "[rdsh] warn: 'dsh' is shadowed by rdsh with no dsh-orig backup in {}; passthrough falls back to {fallback} and install.sh --restore has nothing to restore", "[rdsh] 警告：'dsh' 被 rdsh 遮蔽，且 {} 没有 dsh-orig 备份；passthrough 回退到 {fallback}，install.sh --restore 无法恢复", "[rdsh] 警告: 'dsh' がrdshに隠蔽されていますが、{} にdsh-origのバックアップがありません。passthroughは {fallback} を使用し、install.sh --restore では復元できません",
        dir.display()
    )]
}

/// True when `dsh` on PATH resolves to this binary (install.sh --as-dsh state).
pub(crate) fn shadowing_original() -> bool {
    if crate::cli_dispatch::invoked_as_dsh() {
        return true;
    }
    let Ok(me) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return false;
    };
    std::env::var_os("PATH").is_some_and(|path| path_shadows_current(&path, &me))
}

fn path_shadows_current(path: &std::ffi::OsStr, me: &std::path::Path) -> bool {
    path_executable(path, "dsh")
        .and_then(|candidate| std::fs::canonicalize(candidate).ok())
        .is_some_and(|candidate| candidate == me)
}

fn path_executable(path: &std::ffi::OsStr, name: &str) -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let names: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|ext| ext.starts_with('.') && !ext.contains(['/', '\\']))
        .map(|ext| format!("{name}{ext}"))
        .chain(std::iter::once(name.to_string()))
        .collect();
    #[cfg(not(windows))]
    let names = [name];

    for dir in std::env::split_paths(path) {
        for candidate_name in &names {
            let candidate = dir.join(candidate_name);
            if executable::is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod shadowing_original_tests {
    use super::path_shadows_current;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn searches_os_path_components_for_platform_binary_name() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("rdsh-shadow-path-{}-{nonce}", std::process::id()));
        let decoy = root.join("first");
        let binary_dir = root.join("second");
        fs::create_dir_all(&decoy).unwrap();
        fs::create_dir_all(&binary_dir).unwrap();

        #[cfg(windows)]
        const TEST_NAMES: &[&str] = &["dsh", "dsh.exe"];
        #[cfg(not(windows))]
        const TEST_NAMES: &[&str] = &["dsh"];

        let path = std::env::join_paths([decoy.as_os_str(), binary_dir.as_os_str()]).unwrap();
        for binary_name in TEST_NAMES {
            let candidate = binary_dir.join(*binary_name);
            fs::write(&candidate, b"test executable path").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755)).unwrap();
            }
            let current = fs::canonicalize(&candidate).unwrap();
            assert!(path_shadows_current(&path, &current), "{binary_name}");
            let path_without_candidate = std::env::join_paths([decoy.as_os_str()]).unwrap();
            assert!(!path_shadows_current(&path_without_candidate, &current));
            fs::remove_file(candidate).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod doctor_wrapper_tests {
    use super::{
        broken_wrapper_warnings, origin_ledger_warnings_in, path_binary_hits_in,
        referenced_binary_paths, scan_local_wrappers, shadow_backup_warnings, shebang_interpreter,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("rdsh-doctor-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    #[test]
    fn shebang_and_reference_parsing() {
        assert_eq!(
            shebang_interpreter("#!/usr/bin/env -S node --x").as_deref(),
            Some("node")
        );
        assert_eq!(
            shebang_interpreter("#!/usr/bin/node").as_deref(),
            Some("/usr/bin/node")
        );
        assert_eq!(shebang_interpreter("#!/bin/sh").as_deref(), Some("/bin/sh"));
        assert_eq!(shebang_interpreter("#!/usr/bin/env"), None);
        assert_eq!(
            shebang_interpreter("#!/usr/bin/env -S NODE_NO_WARNINGS=1 node"),
            Some("node".to_string())
        );
        assert_eq!(
            shebang_interpreter("#!/usr/bin/env --unsupported node"),
            None
        );
        assert_eq!(shebang_interpreter("echo hi"), None);

        // Comments (including stale old locations) and quoted paths must not
        // become false findings.
        let refs = referenced_binary_paths(
            "exec /opt/node-v22/bin/node /opt/dsh/lib/bin.js\nPATH=/opt/bin:$PATH\nexec \"/opt/dsh stable/bin/rdsh\" \"$@\" # old: /opt/dead/dsh/bin.js\n# /etc/hosts\n",
        );
        assert_eq!(
            refs,
            vec![
                "/opt/node-v22/bin/node".to_string(),
                "/opt/dsh/lib/bin.js".to_string(),
                "/opt/dsh stable/bin/rdsh".to_string()
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_local_wrapper_is_reported() {
        let root = temp_dir("non-executable");
        let wrapper = root.join("dsh-disabled");
        fs::write(&wrapper, "#!/bin/sh\nexec rdsh \"$@\"\n").unwrap();

        let scan = scan_local_wrappers(&root);
        let broken = broken_wrapper_warnings(&scan, &root, crate::locale::Locale::English);
        assert!(
            broken
                .iter()
                .any(|(name, warning)| name == "dsh-disabled" && warning.contains("not executable")),
            "{broken:?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_wrapper_diagnostic_ignores_an_explicit_js_entry() {
        // docs/DOCTOR.md: an explicit `node /path/to/dsh/index.js` wrapper does
        // not resolve the `dsh` command, so it cannot break when dsh is shadowed.
        let text = |body: &str| super::WrapperScan {
            texts: vec![("dsh-wrapper".to_string(), body.to_string())],
            broken_links: Vec::new(),
            non_executable: Vec::new(),
        };
        assert!(super::node_wrapper_warnings(
            &text("exec /usr/bin/node /opt/dsh/lib/bin.js \"$@\"\n"),
            Path::new("unused"),
            true,
            &[],
            crate::locale::Locale::English
        )
        .is_empty());
        // A quoted Windows path loses its backslashes in shell_words, so the
        // separator check must not require a `/`.
        assert!(super::node_wrapper_warnings(
            &text(r#"node "C:\Users\me\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" %*"#),
            Path::new("unused"),
            true,
            &[],
            crate::locale::Locale::English
        )
        .is_empty());
        // The command-substitution form still breaks, so it keeps its warning.
        let warnings = super::node_wrapper_warnings(
            &text("exec node \"$(command -v dsh)\" \"$@\"\n"),
            Path::new("unused"),
            true,
            &[],
            crate::locale::Locale::English,
        );
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("dsh-wrapper"), "{warnings:?}");
    }

    #[test]
    fn node_wrapper_diagnostic_ignores_comments() {
        let scan = super::WrapperScan {
            texts: vec![(
                "dsh-wrapper".to_string(),
                "exec rdsh \"$@\" # old: node /opt/dsh/lib/bin.js\n".to_string(),
            )],
            broken_links: Vec::new(),
            non_executable: Vec::new(),
        };
        assert!(super::node_wrapper_warnings(
            &scan,
            Path::new("unused"),
            true,
            &[],
            crate::locale::Locale::English
        )
        .is_empty());
    }

    #[test]
    fn broken_wrappers_are_reported_but_healthy_ones_are_not() {
        let root = temp_dir("broken");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("gone").join("dsh.js"), bin.join("dsh-broken"))
            .unwrap();

        #[cfg(unix)]
        let dead_text =
            "#!/bin/sh\nexec /nonexistent-node/bin/node /nonexistent-dsh/lib/bin.js \"$@\"\n";
        #[cfg(not(unix))]
        let dead_text = "exec /nonexistent-node/bin/node /nonexistent-dsh/lib/bin.js %*\n";
        let dead = bin.join("dsh-dead-node");
        fs::write(&dead, dead_text).unwrap();
        make_executable(&dead);

        #[cfg(unix)]
        const HEALTHY: &str = "#!/bin/sh\nexec rdsh \"$@\"\n";
        #[cfg(not(unix))]
        const HEALTHY: &str = "exec rdsh \"$@\"\n";
        let healthy = bin.join("rdsh-ok");
        fs::write(&healthy, HEALTHY).unwrap();
        make_executable(&healthy);

        let scan = scan_local_wrappers(&bin);
        let broken = broken_wrapper_warnings(&scan, &bin, crate::locale::Locale::English);
        let lines: Vec<&str> = broken.iter().map(|(_, warning)| warning.as_str()).collect();
        #[cfg(unix)]
        assert!(
            lines
                .iter()
                .any(|w| w.contains("dsh-broken") && w.contains("broken symlink")),
            "{lines:?}"
        );
        let dead_warning = lines
            .iter()
            .find(|w| w.contains("dsh-dead-node"))
            .expect("a wrapper pointing at a removed node/dsh path must be reported");
        assert!(
            dead_warning.contains("/nonexistent-node/bin/node"),
            "{dead_warning}"
        );
        assert!(
            dead_warning.contains(&dead.display().to_string()),
            "diagnostic must show the directory scanned for wrappers: {dead_warning}"
        );
        assert!(!lines.iter().any(|w| w.contains("rdsh-ok")), "{lines:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_hits_follow_path_order_and_skip_non_candidates() {
        let root = temp_dir("path");
        let first = root.join("first");
        let second = root.join("second");
        let empty = root.join("empty");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        // A directory named dsh never resolves as a binary on any platform.
        fs::create_dir_all(empty.join("dsh")).unwrap();
        for dir in [&first, &second] {
            let dsh = dir.join("dsh");
            fs::write(&dsh, "#!/bin/sh\n").unwrap();
            make_executable(&dsh);
        }
        let path = std::env::join_paths([first.as_os_str(), empty.as_os_str(), second.as_os_str()])
            .unwrap();
        assert_eq!(
            path_binary_hits_in(&path, "dsh"),
            vec![first.join("dsh"), second.join("dsh")]
        );

        #[cfg(unix)]
        {
            // Mode bits alone must not accept a file nobody can execute.
            let noexec = root.join("noexec");
            fs::create_dir_all(&noexec).unwrap();
            fs::write(noexec.join("dsh"), "#!/bin/sh\n").unwrap();
            let path = std::env::join_paths([noexec.as_os_str()]).unwrap();
            assert!(path_binary_hits_in(&path, "dsh").is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shadow_backup_reports_missing_and_unusable_backups() {
        let root = temp_dir("backup");
        let warnings =
            shadow_backup_warnings(&root, Some("/orig/dsh"), crate::locale::Locale::English);
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains("no dsh-orig backup"),
            "{}",
            warnings[0]
        );
        assert!(warnings[0].contains("/orig/dsh"), "{}", warnings[0]);

        #[cfg(unix)]
        {
            let backup = root.join("dsh-orig");
            fs::write(&backup, "#!/bin/sh\n").unwrap();
            let warnings =
                shadow_backup_warnings(&root, Some("/orig/dsh"), crate::locale::Locale::English);
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("not executable"), "{}", warnings[0]);
            make_executable(&backup);
            assert!(shadow_backup_warnings(
                &root,
                Some("/orig/dsh"),
                crate::locale::Locale::English
            )
            .is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn origin_ledger_reports_stale_entries() {
        let root = temp_dir("ledger");
        let ledger = root.join("origin");
        assert!(
            origin_ledger_warnings_in(&ledger, None, crate::locale::Locale::English).is_empty()
        );

        fs::write(
            &ledger,
            format!("{}\n", root.join("gone-dsh-orig").display()),
        )
        .unwrap();
        let warnings = origin_ledger_warnings_in(&ledger, None, crate::locale::Locale::English);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("no longer exists"), "{}", warnings[0]);

        let backup = root.join("dsh-orig");
        fs::write(&backup, "#!/bin/sh\n").unwrap();
        make_executable(&backup);
        fs::write(&ledger, format!("{}\n", backup.display())).unwrap();
        let same = backup.display().to_string();
        assert!(
            origin_ledger_warnings_in(&ledger, Some(&same), crate::locale::Locale::English)
                .is_empty()
        );
        let warnings =
            origin_ledger_warnings_in(&ledger, Some("/other/dsh"), crate::locale::Locale::English);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("/other/dsh"), "{}", warnings[0]);

        #[cfg(unix)]
        {
            let plain = root.join("plain-orig");
            fs::write(&plain, "#!/bin/sh\n").unwrap();
            fs::write(&ledger, format!("{}\n", plain.display())).unwrap();
            let warnings = origin_ledger_warnings_in(&ledger, None, crate::locale::Locale::English);
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("not executable"), "{}", warnings[0]);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
