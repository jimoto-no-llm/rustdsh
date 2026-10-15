use std::{
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--descendant") {
        thread::sleep(Duration::from_secs(60));
        return;
    }

    let repository = PathBuf::from(&args[1]);
    let command = args[2].to_string_lossy();
    let descendants = repository.join(".git").join("worker-git-descendants");
    let child = Command::new(env::current_exe().expect("fake Git executable"))
        .arg("--descendant")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start descendant");
    writeln!(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(descendants)
            .expect("open descendant list"),
        "{}",
        child.id()
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
