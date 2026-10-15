use std::{
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    thread,
    time::Duration,
};

#[cfg(not(windows))]
use std::process::{Command, Stdio};

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

#[cfg(windows)]
fn spawn_descendant() -> std::io::Result<u32> {
    use std::{
        ffi::c_void,
        mem::size_of,
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: *mut c_void,
        h_std_output: *mut c_void,
        h_std_error: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInformation {
        process: *mut c_void,
        thread: *mut c_void,
        process_id: u32,
        thread_id: u32,
    }

    unsafe extern "system" {
        fn CreateProcessW(
            application_name: *const u16,
            command_line: *mut u16,
            process_attributes: *mut c_void,
            thread_attributes: *mut c_void,
            inherit_handles: i32,
            creation_flags: u32,
            environment: *mut c_void,
            current_directory: *const u16,
            startup_info: *const StartupInfoW,
            process_information: *mut ProcessInformation,
        ) -> i32;
        fn CloseHandle(object: *mut c_void) -> i32;
    }

    let executable = env::current_exe()?;
    let mut application_name: Vec<u16> = executable.as_os_str().encode_wide().collect();
    application_name.push(0);
    let mut command_line = Vec::with_capacity(application_name.len() + 16);
    command_line.push(b'"' as u16);
    command_line.extend(executable.as_os_str().encode_wide());
    command_line.extend([b'"' as u16, b' ' as u16]);
    command_line.extend("--descendant".encode_utf16());
    command_line.push(0);
    let mut startup_info: StartupInfoW = unsafe { std::mem::zeroed() };
    startup_info.cb = size_of::<StartupInfoW>() as u32;
    let mut process_information: ProcessInformation = unsafe { std::mem::zeroed() };

    let created = unsafe {
        CreateProcessW(
            application_name.as_ptr(),
            command_line.as_mut_ptr(),
            null_mut(),
            null_mut(),
            0,
            0x0800_0000,
            null_mut(),
            null(),
            &startup_info,
            &mut process_information,
        )
    };
    if created == 0 {
        return Err(std::io::Error::last_os_error());
    }
    unsafe {
        CloseHandle(process_information.thread);
        CloseHandle(process_information.process);
    }
    Ok(process_information.process_id)
}

#[cfg(not(windows))]
fn spawn_descendant() -> std::io::Result<u32> {
    Ok(Command::new(env::current_exe()?)
        .arg("--descendant")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?
        .id())
}

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--descendant") {
        thread::sleep(Duration::from_secs(60));
        return;
    }

    let repository = PathBuf::from(&args[1]);
    let command = args[2].to_string_lossy();
    let descendants = repository.join(".git").join("worker-git-descendants");
    let child_pid = spawn_descendant().expect("start descendant");
    writeln!(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(descendants)
            .expect("open descendant list"),
        "{}",
        child_pid
    )
    .expect("record descendant PID");

    match command.as_ref() {
        "rev-parse" => {
            println!();
            println!(
                "{}",
                fs::canonicalize(repository.join(".git"))
                    .expect("canonicalize Git directory")
                    .display()
            );
            println!("{HEAD}");
        }
        "status" => print!("## main\0"),
        _ => std::process::exit(2),
    }
}
