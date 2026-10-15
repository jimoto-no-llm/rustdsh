fn main() {
    println!("cargo:rerun-if-changed=assets/rdsh.rc");
    println!("cargo:rerun-if-changed=assets/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|s| s == "windows") {
        // Windows reserves 1 MiB for the main thread while Linux and macOS
        // reserve 8 MiB. Debug builds already need close to 1 MiB for clap's
        // command tree, so ask MSVC for the same 8 MiB reserve instead of
        // overflowing inside the context-hook path.
        if std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|s| s == "msvc") {
            println!("cargo:rustc-link-arg-bins=/STACK:8388608");
        }
        embed_resource::compile_for("assets/rdsh.rc", ["rdsh"], embed_resource::NONE)
            .manifest_required()
            .expect("Windows rdsh icon resource compilation failed");
    }
}
