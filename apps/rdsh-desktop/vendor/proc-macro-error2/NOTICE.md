# proc-macro-error2 compatibility patch

Source: the published `proc-macro-error2` 2.0.1 crate from crates.io.
Archive SHA256: `11ec05c52be0a07b08061f7dd003e7d7092e0472bc731b4af7bb1ef876109802`.
Upstream: <https://github.com/GnomedDev/proc-macro-error-2>.
License: MIT OR Apache-2.0; both original license files are included.

GPUI 0.2.2 depends on stacksafe-macro 0.1.4, which uses this crate.
The compatibility change makes `extern crate proc_macro` public, matching
its existing public re-export from `__export`. It addresses
[Rust issue 127909](https://github.com/rust-lang/rust/issues/127909)
without suppressing `pub_use_of_private_extern_crate`.

Runtime sources are otherwise unchanged except for rustfmt formatting.
The README has formatting and image-alt-text fixes for repository Markdown lint.
The normalized manifest omits upstream test targets and dev dependencies;
the upstream UI fixtures are not shipped in this runtime-only copy.
Remove this patch when the dependency chain provides the compatibility fix.
