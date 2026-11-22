use std::sync::{Mutex, MutexGuard, OnceLock};

// Serializes process-wide environment access. Reentrant so guarded tests can
// call environment-sensitive code that takes the same lock.
std::thread_local! {
    static DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    static HELD: std::cell::RefCell<Option<MutexGuard<'static, ()>>> =
        const { std::cell::RefCell::new(None) };
}

pub(crate) fn env_lock() -> EnvLock {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let depth = DEPTH.with(|d| {
        let depth = d.get() + 1;
        d.set(depth);
        depth
    });
    if depth == 1 {
        let guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        HELD.with(|held| *held.borrow_mut() = Some(guard));
    }
    EnvLock
}

pub(crate) struct EnvLock;

impl Drop for EnvLock {
    fn drop(&mut self) {
        let depth = DEPTH.with(|d| {
            let depth = d.get().saturating_sub(1);
            d.set(depth);
            depth
        });
        if depth == 0 {
            let _guard = HELD.with(|held| held.borrow_mut().take());
        }
    }
}

/// Saves process-environment values for one test and restores them on drop,
/// even when an assertion unwinds the stack.
///
/// Hold [`env_lock`] alongside this guard: it restores exactly the values that
/// were present when it was created, so an unguarded test interleaving
/// `set_var` would make that restoration wrong.
pub(crate) struct EnvGuard {
    saved: Vec<(String, Option<String>)>,
}

impl EnvGuard {
    /// Remember the current value of every named variable and leave it as is.
    pub(crate) fn save(names: &[&str]) -> Self {
        let saved = names
            .iter()
            .map(|name| ((*name).to_string(), std::env::var(name).ok()))
            .collect();
        Self { saved }
    }

    /// [`save`](Self::save) the current values, then set the pairs: `None`
    /// removes the variable, `Some` sets it.
    pub(crate) fn apply(pairs: &[(&str, Option<&str>)]) -> Self {
        let guard = Self::save(&pairs.iter().map(|(name, _)| *name).collect::<Vec<_>>());
        for (name, value) in pairs {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        guard
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[cfg(test)]
mod env_guard_tests {
    /// Every name this module touches, so no other test can interfere.
    const NAMES: [&str; 2] = ["RDSH_TEST_SUPPORT_GUARD", "RDSH_TEST_SUPPORT_ABSENT"];

    #[test]
    fn guard_restores_set_and_removed_values() {
        let _lock = super::env_lock();
        let original = std::env::var(NAMES[0]).ok();
        let guard = super::EnvGuard::save(&NAMES);
        std::env::set_var(NAMES[0], "original");
        std::env::remove_var(NAMES[1]);
        drop(guard);

        // Re-apply through `apply`, which must capture before it mutates.
        let guard =
            super::EnvGuard::apply(&[(NAMES[0], Some("replaced")), (NAMES[1], Some("added"))]);
        assert_eq!(std::env::var(NAMES[0]).as_deref(), Ok("replaced"));
        assert_eq!(std::env::var(NAMES[1]).as_deref(), Ok("added"));
        drop(guard);
        // The guard restores what it saw, so nothing outside this test leaks.
        assert_eq!(std::env::var(NAMES[0]).ok(), original);
        assert!(std::env::var(NAMES[1]).is_err());
    }
}
