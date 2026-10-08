/// dsh-compatible launcher arg splitter (mirrors lib/bin.js semantics, read-only).
/// Launcher flags come first; first unrecognized token starts inner app-args.
/// `dsh <name>` abbreviates `dsh --profile <name>`.
pub enum Launcher {
    Help,
    Boot {
        profile: String,
        from_default: Option<String>,
        patches: Vec<String>,
        app_args: Vec<String>,
    },
    Dump {
        profile: String,
        patches: Vec<String>,
    },
    Plugin {
        profile: String,
        pnpm_args: Vec<String>,
    },
    Error(String),
}

pub fn split_launcher_args(profile_flag: Option<String>, extra: Vec<String>) -> Launcher {
    if extra.first().map(|s| s.as_str()) == Some("plugin") {
        let mut profile = profile_flag;
        let mut pnpm: Vec<String> = vec![];
        let mut it = extra.into_iter().skip(1);
        while let Some(a) = it.next() {
            if a == "--profile" {
                profile = it.next();
            } else if let Some(v) = a.strip_prefix("--profile=") {
                profile = Some(v.to_string());
            } else {
                pnpm.push(a);
                pnpm.extend(it);
                break;
            }
        }
        return match profile {
            Some(p) if !p.is_empty() && !pnpm.is_empty() => Launcher::Plugin {
                profile: p,
                pnpm_args: pnpm,
            },
            _ if pnpm.is_empty() => Launcher::Error(
                "error: plugin needs pnpm arguments to forward (e.g. add <package>)".into(),
            ),
            _ => Launcher::Error("error: --profile <name> is required".into()),
        };
    }
    let mut profile = profile_flag;
    let mut from_default: Option<String> = None;
    let mut patches: Vec<String> = vec![];
    let mut dump = false;
    let mut dump_default = false;
    let mut dump_schema = false;
    let mut app_args: Vec<String> = vec![];
    let mut positional: Vec<String> = vec![];
    let mut it = extra.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" if profile.is_none() && positional.is_empty() => return Launcher::Help,
            "--profile" => {
                if profile.is_some() {
                    return Launcher::Error("error: select a profile only once".into());
                }
                profile = it.next();
                if profile.is_none() {
                    return Launcher::Error("error: --profile needs a name".into());
                }
            }
            "--from-default-profile" => from_default = it.next(),
            "--patch" => match it.next() {
                Some(p) if !p.is_empty() => patches.push(p),
                _ => return Launcher::Error("error: --patch needs a path".into()),
            },
            "--dump-config" => dump = true,
            "--dump-default-config" => dump_default = true,
            "--dump-config-schema" => dump_schema = true,
            _ if a.starts_with("--profile=") => {
                if profile.is_some() {
                    return Launcher::Error("error: select a profile only once".into());
                }
                profile = a.strip_prefix("--profile=").map(|v| v.to_string());
            }
            _ if a.starts_with('-') => {
                app_args.push(a);
                app_args.extend(it);
                break;
            }
            _ => positional.push(a),
        }
    }
    if profile.is_none() {
        if let Some(p) = positional.into_iter().next() {
            profile = Some(p);
        }
    } else if !positional.is_empty() {
        app_args = [positional, app_args].concat();
    }
    let profile = match profile {
        Some(p) if !p.is_empty() => p,
        _ => {
            if dump || dump_default || dump_schema {
                return Launcher::Error("error: --profile <name> is required".into());
            }
            return Launcher::Help;
        }
    };
    if profile.to_lowercase() == "desktop" {
        return Launcher::Error(
            "error: profile desktop is managed exclusively by the Electron application".into(),
        );
    }
    let dumps = [dump, dump_default, dump_schema]
        .iter()
        .filter(|&&x| x)
        .count();
    if dumps > 1 {
        return Launcher::Error("error: --dump-config, --dump-default-config, and --dump-config-schema are mutually exclusive".into());
    }
    if dumps == 1 {
        if !app_args.is_empty() {
            return Launcher::Error("error: config dumps take no app arguments".into());
        }
        if dump_default && !patches.is_empty() {
            return Launcher::Error(
                "error: --dump-default-config prints the bundle layers and takes no --patch".into(),
            );
        }
        return Launcher::Dump { profile, patches };
    }
    if app_args.first().map(|s| s.as_str()) == Some("--") {
        app_args.remove(0);
    }
    Launcher::Boot {
        profile,
        from_default,
        patches,
        app_args,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn positional_is_profile() {
        match split_launcher_args(None, sv(&["tui"])) {
            Launcher::Boot {
                profile, app_args, ..
            } => {
                assert_eq!(profile, "tui");
                assert!(app_args.is_empty());
            }
            _ => panic!("expected boot"),
        }
    }

    #[test]
    fn unknown_flag_starts_app_args() {
        match split_launcher_args(Some("tui".into()), sv(&["--resume", "abc"])) {
            Launcher::Boot {
                profile, app_args, ..
            } => {
                assert_eq!(profile, "tui");
                assert_eq!(app_args, sv(&["--resume", "abc"]));
            }
            _ => panic!("expected boot"),
        }
    }

    #[test]
    fn rejects_desktop() {
        match split_launcher_args(None, sv(&["desktop"])) {
            Launcher::Error(_) => {}
            _ => panic!("expected error"),
        }
    }

    #[test]
    fn rejects_double_profile() {
        match split_launcher_args(Some("a".into()), sv(&["--profile", "b"])) {
            Launcher::Error(_) => {}
            _ => panic!("expected error"),
        }
    }

    #[test]
    fn rejects_dump_with_args() {
        match split_launcher_args(Some("tui".into()), sv(&["--dump-config", "--foo"])) {
            Launcher::Error(_) => {}
            _ => panic!("expected error"),
        }
    }

    #[test]
    fn plugin_needs_pnpm_args() {
        match split_launcher_args(Some("tui".into()), sv(&["plugin"])) {
            Launcher::Error(_) => {}
            _ => panic!("expected error"),
        }
    }
}
