//! Small signal bridge so local servers can clean up per-process handoff files.

use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn requested() -> bool {
    REQUESTED.load(Ordering::Relaxed)
}

#[cfg(unix)]
pub fn install() -> anyhow::Result<()> {
    extern "C" fn request_shutdown(_: libc::c_int) {
        REQUESTED.store(true, Ordering::Relaxed);
    }

    unsafe {
        for signal in [libc::SIGINT, libc::SIGTERM] {
            if libc::signal(signal, request_shutdown as *const () as libc::sighandler_t)
                == libc::SIG_ERR
            {
                anyhow::bail!("could not install server shutdown signal handler");
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn install() -> anyhow::Result<()> {
    unsafe extern "system" fn request_shutdown(event: u32) -> i32 {
        const CTRL_C_EVENT: u32 = 0;
        const CTRL_BREAK_EVENT: u32 = 1;
        if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT {
            REQUESTED.store(true, Ordering::Relaxed);
            1
        } else {
            0
        }
    }

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }

    if unsafe { SetConsoleCtrlHandler(Some(request_shutdown), 1) } == 0 {
        anyhow::bail!("could not install server shutdown signal handler");
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn install() -> anyhow::Result<()> {
    Ok(())
}
