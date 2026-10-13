//! Read-only executable checks shared by discovery, Desktop and host diagnostics.
use std::path::Path;

/// Require a regular file that the effective user can execute. On Unix, a mode
/// bit belonging to another permission class does not make the file runnable.
pub(crate) fn is_executable(path: &Path) -> bool {
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
        // SAFETY: c_path is NUL-terminated; AT_FDCWD makes this a read-only query.
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
