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
