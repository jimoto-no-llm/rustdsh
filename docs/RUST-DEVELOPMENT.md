# Rust development setup

The repository selects the Rust **stable channel** in `rust-toolchain.toml` and
installs `rustfmt` and `clippy` when `rustup` enters the checkout. The package's
minimum supported Rust version is 1.85; CI checks that MSRV separately from the
stable test matrix.

## Editor

Opening the repository in VS Code prompts for the recommended extensions:

- Rust Analyzer for navigation, diagnostics, and formatting.
- CodeLLDB for Rust debugging.
- Even Better TOML for Cargo and tool configuration files.

Workspace settings enable format-on-save, check all Cargo targets, and use
Clippy for editor diagnostics. These settings do not replace the CI gates.

## Local Rust checks

Install `cargo-nextest` and `cargo-audit` once:

```sh
cargo install cargo-nextest --locked
cargo install cargo-audit --locked
```

Run the same Rust checks used by CI:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo nextest run --locked --all-targets --profile ci
cargo audit
```

Nextest runs each discovered test and emits a JUnit report at
`target/nextest/ci/junit.xml`. This package currently has no library target, so
there is no Rustdoc test suite; add an explicit Cargo doctest check if a library
target is introduced. RustSec checks `Cargo.lock` against its advisory database
on every pull request and weekly on `main`.

These checks cover Rust code and Rust dependencies. The broader release,
installer, dashboard, plugin, and cross-platform matrix remains in
`CONTRIBUTING.md` and the CI workflows.
