fn main() {
    println!("cargo:rerun-if-changed=assets/rdsh.rc");
    println!("cargo:rerun-if-changed=assets/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|s| s == "windows") {
        embed_resource::compile_for("assets/rdsh.rc", ["rdsh"], embed_resource::NONE)
            .manifest_required()
            .expect("Windows rdsh icon resource compilation failed");
    }
}
