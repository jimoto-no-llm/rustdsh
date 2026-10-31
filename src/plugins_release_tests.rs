use super::*;
use crate::plugins_tar::tests::Builder;
use std::cell::RefCell;
use std::collections::HashMap;

const SETTINGS_JSON: &str = r#"{"name":"rdsh-settings","version":"1.0.0"}"#;

/// A tarball shaped like the release asset; `stamp` tells versions apart.
fn bundle(stamp: &str) -> Vec<u8> {
    Builder::default()
        .dir("plugins/")
        .entry("plugins/install.sh", b'0', b"#!/bin/sh\n", 0o755)
        .dir("plugins/rdsh-settings/")
        .file(
            "plugins/rdsh-settings/package.json",
            SETTINGS_JSON.as_bytes(),
        )
        .file("plugins/rdsh-settings/stamp.txt", stamp.as_bytes())
        .dir("plugins/rdsh-translation/")
        .file(
            "plugins/rdsh-translation/package.json",
            br#"{"name":"rdsh-translation"}"#,
        )
        .finish()
}

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rdsh-release-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn env_in(home: &Path) -> OsEnv {
    let mut env = OsEnv::from_process();
    env.dsh_home = home.to_path_buf();
    env.plugins_dir = None;
    env
}

/// A table of URL -> body. Nothing here can reach the network.
#[derive(Default)]
struct FakeFetch {
    bodies: RefCell<HashMap<String, Vec<u8>>>,
    calls: RefCell<Vec<String>>,
}

fn asset_url(tag: &str, name: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/{tag}/{name}")
}

impl FakeFetch {
    /// Publish `tag` with `archive`. `api_digest` / `sidecar` choose which
    /// digest sources exist; `latest` also makes it `/releases/latest`.
    fn publish(&self, tag: &str, archive: &[u8], api_digest: bool, sidecar: bool, latest: bool) {
        let digest = upd::sha256_hex(archive);
        let mut asset = json!({
            "name": ASSET,
            "browser_download_url": asset_url(tag, ASSET),
        });
        if api_digest {
            asset["digest"] = json!(format!("sha256:{digest}"));
        }
        let mut assets = vec![asset];
        if sidecar {
            assets.push(json!({
                "name": format!("{ASSET}.sha256"),
                "browser_download_url": asset_url(tag, &format!("{ASSET}.sha256")),
            }));
            self.put(
                &asset_url(tag, &format!("{ASSET}.sha256")),
                format!("{digest}  {ASSET}\n").into_bytes(),
            );
        }
        let release = json!({"tag_name": tag, "assets": assets})
            .to_string()
            .into_bytes();
        self.put(&tag_api_url(tag), release.clone());
        if latest {
            self.put(&latest_api_url(), release);
        }
        self.put(&asset_url(tag, ASSET), archive.to_vec());
    }

    fn pin_ledger(&self, tag: &str, digest: &str) {
        self.put(
            LEDGER_URL,
            format!("# ledger\nlatest {tag}\n{tag} {ASSET} {digest}\n").into_bytes(),
        );
    }

    fn put(&self, url: &str, body: Vec<u8>) {
        self.bodies.borrow_mut().insert(url.to_string(), body);
    }

    fn network_calls(&self) -> usize {
        self.calls.borrow().len()
    }
}

impl Fetch for FakeFetch {
    fn get(&self, url: &str, limit: usize, _timeout: Duration) -> Result<Vec<u8>> {
        self.calls.borrow_mut().push(url.to_string());
        let body = self
            .bodies
            .borrow()
            .get(url)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("404 {url}"))?;
        ensure!(body.len() <= limit, "{url} is larger than {limit} bytes");
        Ok(body)
    }
}

fn stamp(root: &Path) -> String {
    std::fs::read_to_string(root.join("current/plugins/rdsh-settings/stamp.txt")).unwrap()
}

// ------------------------------------------------------------------ digests

#[test]
fn the_ledger_row_for_the_tag_is_found() {
    let digest = "a".repeat(64);
    let text = format!(
        "# header\nlatest v0.2.0\nv0.1.0 {ASSET} {}\nv0.2.0 {ASSET} {digest}\nv0.3.0 other.tgz {digest}\nv0.4.0 {ASSET} nothex\n",
        "b".repeat(64)
    );
    assert_eq!(ledger_digest(&text, "v0.2.0"), Some(digest.clone()));
    assert_eq!(ledger_digest(&text, "v0.1.0"), Some("b".repeat(64)));
    assert_eq!(ledger_digest(&text, "v0.3.0"), None, "another asset");
    assert_eq!(ledger_digest(&text, "v0.4.0"), None, "not a sha256");
    assert_eq!(ledger_digest(&text, "v9.9.9"), None);
}

#[test]
fn download_accepts_one_source_and_refuses_disagreement_or_none() {
    let archive = bundle("a");
    let digest = upd::sha256_hex(&archive);
    let release =
        |fetch: &FakeFetch| upd::fetch_release_from(fetch, &tag_api_url("v1.0.0")).unwrap();

    // The API digest alone is enough.
    let fetch = FakeFetch::default();
    fetch.publish("v1.0.0", &archive, true, false, false);
    assert_eq!(
        download_verified(&fetch, &release(&fetch)).unwrap(),
        archive
    );

    // The sidecar alone is enough.
    let fetch = FakeFetch::default();
    fetch.publish("v1.0.0", &archive, false, true, false);
    assert!(download_verified(&fetch, &release(&fetch)).is_ok());

    // No digest at all is a refusal.
    let fetch = FakeFetch::default();
    fetch.publish("v1.0.0", &archive, false, false, false);
    let error = download_verified(&fetch, &release(&fetch)).unwrap_err();
    assert!(error.to_string().contains("no sha256"), "{error}");

    // A pinned ledger entry that disagrees with the (valid) API digest refuses.
    let fetch = FakeFetch::default();
    fetch.publish("v1.0.0", &archive, true, true, false);
    fetch.pin_ledger("v1.0.0", &"0".repeat(64));
    let error = download_verified(&fetch, &release(&fetch)).unwrap_err();
    assert!(error.to_string().contains("mismatch"), "{error}");

    // The ledger agreeing is fine, and it alone can carry an unpinned API.
    let fetch = FakeFetch::default();
    fetch.publish("v1.0.0", &archive, false, false, false);
    fetch.pin_ledger("v1.0.0", &digest);
    assert!(download_verified(&fetch, &release(&fetch)).is_ok());

    // Corrupted bytes fail against every source.
    let fetch = FakeFetch::default();
    fetch.publish("v1.0.0", &archive, true, true, false);
    let rel = release(&fetch);
    fetch.put(&asset_url("v1.0.0", ASSET), b"tampered".to_vec());
    assert!(download_verified(&fetch, &rel).is_err());
}

#[test]
fn download_only_trusts_this_repositorys_release_urls() {
    let archive = bundle("a");
    let fetch = FakeFetch::default();
    fetch.publish("v1.0.0", &archive, true, false, false);
    let mut release = upd::fetch_release_from(&fetch, &tag_api_url("v1.0.0")).unwrap();
    for url in [
        "https://example.com/rdsh-plugins.tar.gz",
        "http://github.com/jimoto-no-llm/rustdsh/releases/download/v1.0.0/rdsh-plugins.tar.gz",
        "https://github.com/someone-else/rustdsh/releases/download/v1.0.0/rdsh-plugins.tar.gz",
        // A different tag's asset under this release's name.
        "https://github.com/jimoto-no-llm/rustdsh/releases/download/v0.0.1/rdsh-plugins.tar.gz",
    ] {
        release.assets[0].url = url.to_string();
        assert!(download_verified(&fetch, &release).is_err(), "{url}");
    }
    assert_eq!(
        fetch.network_calls(),
        1,
        "only the release JSON was fetched"
    );
}

// ------------------------------------------------------- unpack and replace

#[test]
fn install_places_current_and_records_the_tag() {
    let home = scratch("install");
    let root = home.join("rdsh-plugins");
    install_archive(&root, "v1.0.0", &bundle("one")).unwrap();
    assert_eq!(current_tag(&root).as_deref(), Some("v1.0.0"));
    assert_eq!(stamp(&root), "one");
    assert!(root.join("current/plugins/install.sh").is_file());
    let leftovers: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".stage-"))
        .collect();
    assert!(leftovers.is_empty(), "staging directory left behind");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn replacing_keeps_the_old_tree_and_only_two_generations() {
    let home = scratch("generations");
    let root = home.join("rdsh-plugins");
    for (tag, stamp_text) in [
        ("v1.0.0", "one"),
        ("v1.1.0", "two"),
        ("v1.2.0", "three"),
        ("v1.3.0", "four"),
    ] {
        install_archive(&root, tag, &bundle(stamp_text)).unwrap();
        assert_eq!(stamp(&root), stamp_text);
        assert_eq!(current_tag(&root).as_deref(), Some(tag));
    }
    let mut kept: Vec<String> = std::fs::read_dir(root.join("previous"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    kept.sort();
    assert_eq!(kept, ["v1.1.0", "v1.2.0"], "the two newest replaced trees");
    assert!(root.join("current").is_dir());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn pruning_touches_only_names_it_created() {
    let home = scratch("prune");
    let root = home.join("rdsh-plugins");
    for name in ["v1.0.0", "v1.1.0", "v1.2.0", "unknown-1", "mine", "v1.x"] {
        std::fs::create_dir_all(root.join("previous").join(name)).unwrap();
    }
    std::fs::write(root.join("previous").join("v0.0.1"), "a file").unwrap();
    prune_previous(&root, 2);
    let mut left: Vec<String> = std::fs::read_dir(root.join("previous"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["mine", "v0.0.1", "v1.1.0", "v1.2.0", "v1.x"]);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_bad_archive_leaves_current_untouched_and_cleans_up() {
    let home = scratch("atomic");
    let root = home.join("rdsh-plugins");
    install_archive(&root, "v1.0.0", &bundle("good")).unwrap();

    let with_link = Builder::default()
        .dir("plugins/")
        .entry("plugins/install.sh", b'0', b"#!/bin/sh\n", 0o755)
        .entry("plugins/evil", b'2', b"", 0o777)
        .finish();
    let no_settings = Builder::default()
        .dir("plugins/")
        .entry("plugins/install.sh", b'0', b"#!/bin/sh\n", 0o755)
        .finish();
    let no_installer = Builder::default()
        .file(
            "plugins/rdsh-settings/package.json",
            SETTINGS_JSON.as_bytes(),
        )
        .finish();
    for (label, archive) in [
        ("link", with_link),
        ("no settings", no_settings),
        ("no installer", no_installer),
        ("garbage", b"not gzip".to_vec()),
    ] {
        assert!(
            install_archive(&root, "v2.0.0", &archive).is_err(),
            "{label}"
        );
        assert_eq!(current_tag(&root).as_deref(), Some("v1.0.0"), "{label}");
        assert_eq!(stamp(&root), "good", "{label}");
        let staged = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(".stage-"));
        assert!(!staged, "{label}: staging directory left behind");
    }
    assert!(install_archive(&root, "../escape", &bundle("x")).is_err());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn reinstalling_the_same_tag_does_not_create_a_previous_copy() {
    let home = scratch("same-tag");
    let root = home.join("rdsh-plugins");
    install_archive(&root, "v1.0.0", &bundle("a")).unwrap();
    install_archive(&root, "v1.0.0", &bundle("b")).unwrap();
    assert_eq!(stamp(&root), "b");
    assert!(!root.join("previous").exists());
    let _ = std::fs::remove_dir_all(&home);
}

// --------------------------------------------------------- which version

#[test]
fn provision_takes_the_running_tag_and_then_stays_offline() {
    let home = scratch("provision");
    let env = env_in(&home);
    let fetch = FakeFetch::default();
    let own = binary_tag();
    fetch.publish(&own, &bundle("own"), true, false, false);
    fetch.publish("v99.0.0", &bundle("newest"), true, false, true);

    let first = provision(&env, &fetch, Want::Binary, 100).unwrap();
    assert_eq!(
        first,
        Provisioned {
            tag: own.clone(),
            changed: true
        }
    );
    assert_eq!(stamp(&root(&env)), "own");
    assert_eq!(
        managed_plugins_dir(&env),
        Some(root(&env).join("current/plugins"))
    );

    let calls = fetch.network_calls();
    let second = provision(&env, &fetch, Want::Binary, 200).unwrap();
    assert!(!second.changed);
    assert_eq!(
        fetch.network_calls(),
        calls,
        "an existing copy needs no network"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn provision_falls_back_to_latest_when_the_running_tag_has_no_archive() {
    let home = scratch("fallback");
    let env = env_in(&home);
    let fetch = FakeFetch::default();
    fetch.publish("v99.0.0", &bundle("newest"), true, false, true);
    let done = provision(&env, &fetch, Want::Binary, 100).unwrap();
    assert_eq!(done.tag, "v99.0.0");
    assert_eq!(stamp(&root(&env)), "newest");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn latest_replaces_an_older_copy_and_never_downgrades() {
    let home = scratch("latest");
    let env = env_in(&home);
    let fetch = FakeFetch::default();
    install_archive(&root(&env), "v1.0.0", &bundle("old")).unwrap();
    fetch.publish("v2.0.0", &bundle("new"), true, false, true);

    let done = provision(&env, &fetch, Want::Latest, 100).unwrap();
    assert_eq!(
        done,
        Provisioned {
            tag: "v2.0.0".into(),
            changed: true
        }
    );
    assert_eq!(stamp(&root(&env)), "new");

    // The latest release is now older than the copy: nothing changes.
    let fetch = FakeFetch::default();
    fetch.publish("v1.5.0", &bundle("older"), true, false, true);
    let done = provision(&env, &fetch, Want::Latest, 200).unwrap();
    assert!(!done.changed);
    assert_eq!(stamp(&root(&env)), "new");
    assert!(
        !fetch.calls.borrow().iter().any(|u| u.ends_with(ASSET)),
        "no download"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_failed_fetch_records_a_failure_and_changes_nothing() {
    let home = scratch("fetch-fail");
    let env = env_in(&home);
    let fetch = FakeFetch::default();
    assert!(provision(&env, &fetch, Want::Binary, 500).is_err());
    assert!(managed_plugins_dir(&env).is_none());
    let state = upd::load_state(&state_path(&root(&env)));
    assert_eq!((state.failures, state.last_check), (1, 500));
    let _ = std::fs::remove_dir_all(&home);
}

// ------------------------------------------------------------------ update

#[test]
fn update_without_a_release_copy_does_not_touch_the_network() {
    let home = scratch("not-managed");
    let env = env_in(&home);
    let fetch = FakeFetch::default();
    let mut state = UpdateState::default();
    let report = run_update(&env, &fetch, false, &mut state, 10).unwrap();
    assert_eq!(report.action, Action::NotManaged);
    assert_eq!(fetch.network_calls(), 0);
    assert_eq!(state, UpdateState::default());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn update_check_reports_without_downloading_and_update_replaces() {
    let home = scratch("update");
    let env = env_in(&home);
    install_archive(&root(&env), "v1.0.0", &bundle("old")).unwrap();
    let fetch = FakeFetch::default();
    fetch.publish("v1.1.0", &bundle("new"), true, true, true);
    let mut state = UpdateState::default();

    let report = run_update(&env, &fetch, true, &mut state, 10).unwrap();
    assert_eq!(report.action, Action::Available);
    assert_eq!(
        (report.installed.as_deref(), report.latest.as_deref()),
        (Some("v1.0.0"), Some("v1.1.0"))
    );
    assert!(!fetch.calls.borrow().iter().any(|u| u.ends_with(ASSET)));
    assert_eq!(stamp(&root(&env)), "old");
    assert_eq!(state.latest_tag.as_deref(), Some("v1.1.0"));

    let report = run_update(&env, &fetch, false, &mut state, 20).unwrap();
    assert_eq!(report.action, Action::Updated);
    assert_eq!(stamp(&root(&env)), "new");
    assert_eq!(state.installed_tag.as_deref(), Some("v1.1.0"));
    assert!(root(&env).join("previous/v1.0.0").is_dir());

    let report = run_update(&env, &fetch, false, &mut state, 30).unwrap();
    assert_eq!(report.action, Action::UpToDate);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_failed_update_backs_off_and_keeps_the_current_tree() {
    let home = scratch("update-fail");
    let env = env_in(&home);
    install_archive(&root(&env), "v1.0.0", &bundle("old")).unwrap();
    let fetch = FakeFetch::default();
    fetch.publish("v1.1.0", &bundle("new"), true, false, true);
    fetch.put(&asset_url("v1.1.0", ASSET), b"tampered".to_vec());
    let mut state = UpdateState::default();
    assert!(run_update(&env, &fetch, false, &mut state, 77).is_err());
    assert_eq!((state.failures, state.last_check), (1, 77));
    assert_eq!(stamp(&root(&env)), "old");

    let offline = FakeFetch::default();
    assert!(run_update(&env, &offline, false, &mut state, 90).is_err());
    assert_eq!(state.failures, 2);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_update_reports_linked_packages_the_release_dropped() {
    let home = scratch("dangling");
    let env = env_in(&home);
    install_archive(&root(&env), "v1.0.0", &bundle("old")).unwrap();
    let profile = home.join("profiles/web");
    std::fs::create_dir_all(&profile).unwrap();
    let base = root(&env).join("current/plugins");
    std::fs::write(
        profile.join("package.json"),
        json!({"dependencies": {
            "rdsh-settings": format!("link:{}/rdsh-settings", base.display()),
            "rdsh-gone": format!("link:{}/rdsh-gone", base.display()),
        }})
        .to_string(),
    )
    .unwrap();
    let fetch = FakeFetch::default();
    fetch.publish("v1.1.0", &bundle("new"), true, false, true);
    let mut state = UpdateState::default();
    let report = run_update(&env, &fetch, false, &mut state, 5).unwrap();
    assert_eq!(report.action, Action::Updated);
    assert_eq!(report.dangling, ["rdsh-gone"]);
    let _ = std::fs::remove_dir_all(&home);
}

// ------------------------------------------------------ auto update policy

fn lookup_with<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |name| {
        pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.to_string())
    }
}

#[test]
fn auto_update_decision_follows_the_policy() {
    let day = 24 * 3600;
    let fresh = UpdateState {
        last_check: 1_000_000,
        ..UpdateState::default()
    };
    let now_due = 1_000_000 + day;
    let none = lookup_with(&[]);

    assert_eq!(
        auto_skip_reason(&none, true, &UpdateState::default(), now_due),
        None
    );
    // Not within the interval.
    assert_eq!(
        auto_skip_reason(&none, true, &fresh, 1_000_000 + 60),
        Some(Skip::NotDue)
    );
    assert_eq!(auto_skip_reason(&none, true, &fresh, now_due), None);
    // No profile uses the release copy.
    assert_eq!(
        auto_skip_reason(&none, false, &fresh, now_due),
        Some(Skip::NotManaged)
    );
    // The off switch.
    let off = lookup_with(&[("RDSH_PLUGINS_SKIP_UPDATE", "1")]);
    assert_eq!(
        auto_skip_reason(&off, true, &fresh, now_due),
        Some(Skip::Disabled)
    );
    assert!(!auto_enabled(&off));
    // A user-managed checkout is never fetched for.
    let managed = lookup_with(&[("RDSH_PLUGINS_DIR", "/x/rustdsh")]);
    assert_eq!(
        auto_skip_reason(&managed, true, &fresh, now_due),
        Some(Skip::UserManaged)
    );
    // The interval variable moves the due time; 0 means every time.
    let hourly = lookup_with(&[("RDSH_PLUGINS_UPDATE_INTERVAL_HOURS", "1")]);
    assert_eq!(
        auto_skip_reason(&hourly, true, &fresh, 1_000_000 + 3600),
        None
    );
    let always = lookup_with(&[("RDSH_PLUGINS_UPDATE_INTERVAL_HOURS", "0")]);
    assert_eq!(auto_skip_reason(&always, true, &fresh, 1_000_000), None);
    // After failures the wait is the backoff, not the full day.
    let failing = UpdateState {
        last_check: 1_000_000,
        failures: 1,
        ..UpdateState::default()
    };
    assert_eq!(
        auto_skip_reason(&none, true, &failing, 1_000_000 + 3600),
        None
    );
    assert_eq!(
        auto_skip_reason(&none, true, &failing, 1_000_000 + 600),
        Some(Skip::NotDue)
    );
}

#[test]
fn only_links_into_the_release_copy_count_as_managed() {
    let home = scratch("linked");
    let env = env_in(&home);
    let base = root(&env).join("current/plugins");
    let write = |profile: &str, manifest: Value| {
        let dir = home.join("profiles").join(profile);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), manifest.to_string()).unwrap();
    };
    write(
        "web",
        json!({"dependencies": {
            "rdsh-settings": format!("link:{}/rdsh-settings", base.display()),
            "@deepseek-ai/dsh-tool-present": "0.2.0",
        }}),
    );
    write(
        "tui",
        json!({"dependencies": {"rdsh-settings": "link:/home/me/rustdsh/plugins/rdsh-settings"}}),
    );
    write(
        "copy",
        json!({"dependencies": {"rdsh-settings": format!("file:{}/rdsh-settings", base.display())}}),
    );
    write("broken", json!("not an object"));
    std::fs::write(
        home.join("profiles").join("broken").join("package.json"),
        "{ nope",
    )
    .unwrap();

    assert_eq!(
        linked_packages(&env),
        vec![("web".to_string(), vec!["rdsh-settings".to_string()])]
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_user_named_directory_never_falls_back_to_the_release_copy() {
    let home = scratch("explicit");
    let env = env_in(&home);
    install_archive(&root(&env), "v1.0.0", &bundle("x")).unwrap();
    let managed = root(&env).join("current/plugins");
    let bogus = home.join("not-a-checkout");
    let resolved =
        desktop::resolve_plugins_dir(Some(&bogus.display().to_string()), &env, Locale::English);
    assert_ne!(resolved.ok(), Some(managed.clone()));
    let mut with_env = env.clone();
    with_env.plugins_dir = Some(bogus);
    let resolved = desktop::resolve_plugins_dir(None, &with_env, Locale::English);
    assert_ne!(resolved.ok(), Some(managed));
    let _ = std::fs::remove_dir_all(&home);
}

// ----------------------------------------------------------- status data

#[test]
fn info_names_the_source_and_whether_an_update_is_waiting() {
    let home = scratch("info");
    let env = env_in(&home);
    let none = info(&env, None);
    assert_eq!(
        (none.source, none.tag.clone(), none.auto_update),
        ("none", None, false)
    );

    let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("plugins");
    assert_eq!(info(&env, Some(&checkout)).source, "checkout");

    install_archive(&root(&env), "v1.0.0", &bundle("x")).unwrap();
    let dir = root(&env).join("current/plugins");
    let mut state = UpdateState::default();
    record_latest(&root(&env), &mut state, "v1.2.0", 42);
    let release = info(&env, Some(&dir));
    assert_eq!(release.source, "release");
    assert_eq!(release.tag.as_deref(), Some("v1.0.0"));
    assert_eq!(release.latest.as_deref(), Some("v1.2.0"));
    assert_eq!(release.last_check, Some(42));
    assert!(release.update_available);
    let rendered = info_json(&release);
    assert_eq!(rendered["source"], "release");
    assert_eq!(rendered["update_available"], true);
    assert!(info_line(&release, Locale::Japanese)
        .unwrap()
        .contains("v1.2.0"));

    let lines = doctor_lines(&env, Locale::English);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("rdsh plugins update"), "{}", lines[0]);

    record_latest(&root(&env), &mut state, "v1.0.0", 43);
    assert!(doctor_lines(&env, Locale::English).is_empty());
    let _ = std::fs::remove_dir_all(&home);
}

fn record_latest(root: &Path, state: &mut UpdateState, tag: &str, now: u64) {
    upd::record_success(state, tag, now);
    upd::save_state(&state_path(root), state).unwrap();
}

#[test]
fn tags_are_strictly_plain_versions() {
    for ok in ["v0.14.1", "v10.0.0"] {
        assert!(valid_tag(ok), "{ok}");
    }
    for bad in [
        "0.14.1",
        "v1.2",
        "v1.2.3.4",
        "v1.2.3-rc.1",
        "v1..3",
        "v1.2.x",
        "../v1.2.3",
        "v1.2.3/",
        "",
    ] {
        assert!(!valid_tag(bad), "{bad}");
    }
}
