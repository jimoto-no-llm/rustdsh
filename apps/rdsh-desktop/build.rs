//! Link-time environment fixes for the Linux GPUI build.
//!
//! `gpui` links `xkbcommon-x11` even with the Wayland-only feature set. Fedora
//! and several other distributions ship the runtime library
//! (`libxkbcommon-x11.so.0`) without the development symlink
//! (`libxkbcommon-x11.so`) until `libxkbcommon-x11-devel` is installed, so the
//! linker cannot resolve `-lxkbcommon-x11`. When the runtime library is present
//! we expose it through a private search directory; otherwise the build keeps
//! the upstream behaviour and fails with the linker error.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    println!("cargo:rerun-if-changed=build.rs");

    if pkg_config_finds_dev_symlink() {
        return;
    }
    let Some(runtime) = find_runtime_library() else {
        println!(
            "cargo:warning=libxkbcommon-x11.so.0 not found; install libxkbcommon-x11-devel (Fedora) or libxkbcommon-x11-dev (Debian/Ubuntu) to build the desktop app"
        );
        return;
    };

    let out_dir = std::env::var("OUT_DIR").unwrap_or_else(|_| "target".to_string());
    let shim = std::path::Path::new(&out_dir).join("xkbcommon-x11-shim");
    if std::fs::create_dir_all(&shim).is_err() {
        return;
    }
    let link = shim.join("libxkbcommon-x11.so");
    let _ = std::fs::remove_file(&link);
    #[cfg(unix)]
    if std::os::unix::fs::symlink(&runtime, &link).is_err() {
        return;
    }
    #[cfg(not(unix))]
    return;

    println!("cargo:warning=using the {runtime} runtime library for -lxkbcommon-x11; install libxkbcommon-x11-devel for a supported build");
    println!("cargo:rustc-link-search=native={}", shim.display());
}

fn pkg_config_finds_dev_symlink() -> bool {
    for dir in [
        "/usr/lib64",
        "/usr/lib",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/local/lib",
    ] {
        if std::path::Path::new(dir)
            .join("libxkbcommon-x11.so")
            .exists()
        {
            return true;
        }
    }
    false
}

fn find_runtime_library() -> Option<String> {
    let candidates = [
        "/usr/lib64/libxkbcommon-x11.so.0",
        "/usr/lib/libxkbcommon-x11.so.0",
        "/usr/lib/x86_64-linux-gnu/libxkbcommon-x11.so.0",
        "/usr/local/lib/libxkbcommon-x11.so.0",
    ];
    candidates
        .iter()
        .find(|path| std::path::Path::new(path).exists())
        .map(|path| path.to_string())
}
