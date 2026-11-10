//! One catalog for slash parsing, discovery, completion and help.
use super::*;
#[derive(Clone, Copy)]
pub(super) struct Command {
    pub name: &'static str,
    pub usage: &'static str,
    pub description: &'static str,
    pub needs_idle: bool,
}
pub(super) const COMMANDS: &[Command] = &[
    Command {
        name: "help",
        usage: "/help",
        description: "操作方法を表示",
        needs_idle: false,
    },
    Command {
        name: "model",
        usage: "/model [PROVIDER MODEL]",
        description: "モデルを選択・切り替え",
        needs_idle: true,
    },
    Command {
        name: "mode",
        usage: "/mode [normal|plan]",
        description: "通常・計画モードを表示／切り替え",
        needs_idle: true,
    },
    Command {
        name: "plan",
        usage: "/plan [on|off]",
        description: "計画モードを切り替え",
        needs_idle: true,
    },
    Command {
        name: "permission",
        usage: "/permission [PRESET]",
        description: "権限候補を表示・確認して変更",
        needs_idle: true,
    },
    Command {
        name: "new",
        usage: "/new",
        description: "確認して新しい会話を開始",
        needs_idle: true,
    },
    Command {
        name: "status",
        usage: "/status",
        description: "モデル・作業場所・実行状態",
        needs_idle: false,
    },
    Command {
        name: "usage",
        usage: "/usage",
        description: "トークン・キャッシュ使用量",
        needs_idle: false,
    },
    Command {
        name: "diagnostics",
        usage: "/diagnostics",
        description: "接続診断・利用不可の理由",
        needs_idle: false,
    },
    Command {
        name: "logs",
        usage: "/logs",
        description: "実行ログを表示",
        needs_idle: false,
    },
    Command {
        name: "cancel",
        usage: "/cancel",
        description: "実行中の処理を中止",
        needs_idle: false,
    },
    Command {
        name: "quit",
        usage: "/quit",
        description: "処理を中止して終了",
        needs_idle: false,
    },
    Command {
        name: "models",
        usage: "/models",
        description: "モデル選択（/model と同じ）",
        needs_idle: true,
    },
    Command {
        name: "sessions",
        usage: "/sessions",
        description: "DSH: 保存済みセッションを再開",
        needs_idle: true,
    },
    Command {
        name: "plugins",
        usage: "/plugins",
        description: "DSH: プラグイン情報を閲覧",
        needs_idle: false,
    },
    Command {
        name: "settings",
        usage: "/settings",
        description: "DSH: 設定情報を閲覧",
        needs_idle: false,
    },
    Command {
        name: "clear",
        usage: "/clear",
        description: "新しい会話（/new と同じ確認）",
        needs_idle: true,
    },
    Command {
        name: "exit",
        usage: "/exit",
        description: "終了（/quit と同じ）",
        needs_idle: false,
    },
    Command {
        name: "stop",
        usage: "/stop",
        description: "中止（/cancel と同じ）",
        needs_idle: false,
    },
    Command {
        name: "resume",
        usage: "/resume",
        description: "DSH: 保存会話を再開（/sessions）",
        needs_idle: true,
    },
];
#[derive(Debug, PartialEq)]
pub(super) enum Invocation {
    Help,
    Models,
    Model(String, String),
    Mode(Option<String>),
    Plan(Option<bool>),
    Permission(Option<String>),
    New,
    Status,
    Diagnostics,
    Logs,
    Cancel,
    Quit,
    Sessions,
    Plugins,
    Settings,
}
/// Unknown commands and invalid arity must never become model input.
pub(super) fn parse(text: &str) -> Option<Result<Invocation>> {
    let text = text.trim();
    if !text.starts_with('/') || text.starts_with("//") {
        return None;
    }
    Some((|| {
        if text.contains(['\n', '\r']) {
            bail!("コマンドは1行で入力してください。文章の先頭の / は // と入力できます");
        }
        let parts: Vec<_> = text[1..].split_whitespace().collect();
        let Some(command) = parts
            .first()
            .and_then(|name| COMMANDS.iter().find(|c| c.name == *name))
        else {
            bail!("不明なコマンドです。/ で候補、/help で操作方法を表示します");
        };
        if command.name == "model" && parts.len() == 3 {
            return Ok(Invocation::Model(parts[1].into(), parts[2].into()));
        }
        if command.name == "mode" && parts.len() <= 2 {
            return match parts.get(1).copied() {
                None => Ok(Invocation::Mode(None)),
                Some("normal" | "act") => Ok(Invocation::Mode(Some("normal".into()))),
                Some("plan") => Ok(Invocation::Mode(Some("plan".into()))),
                _ => Err(anyhow::anyhow!("使い方: {}", command.usage)),
            };
        }
        if command.name == "plan" && parts.len() <= 2 {
            return match parts.get(1).copied() {
                None => Ok(Invocation::Plan(None)),
                Some("on") => Ok(Invocation::Plan(Some(true))),
                Some("off") => Ok(Invocation::Plan(Some(false))),
                _ => Err(anyhow::anyhow!("使い方: {}", command.usage)),
            };
        }
        if command.name == "permission" && parts.len() <= 2 {
            let id = parts.get(1).copied();
            if id.is_some_and(|id| {
                id.len() > 100
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
            }) {
                bail!("パーミッションIDが不正です");
            }
            return Ok(Invocation::Permission(id.map(str::to_owned)));
        }
        if parts.len() != 1 {
            bail!("使い方: {}", command.usage);
        }
        Ok(match command.name {
            "help" => Invocation::Help,
            "model" | "models" => Invocation::Models,
            "new" | "clear" => Invocation::New,
            "status" | "usage" => Invocation::Status,
            "diagnostics" => Invocation::Diagnostics,
            "logs" => Invocation::Logs,
            "cancel" | "stop" => Invocation::Cancel,
            "quit" | "exit" => Invocation::Quit,
            "sessions" | "resume" => Invocation::Sessions,
            "plugins" => Invocation::Plugins,
            "settings" => Invocation::Settings,
            _ => unreachable!(),
        })
    })())
}
impl App {
    pub(super) fn palette_open(&self) -> bool {
        matches!(self.overlay, Overlay::None)
            && !self.has_pending()
            && self.editor.text.starts_with('/')
            && !self.editor.text.starts_with("//")
            && !self.editor.text.chars().any(char::is_whitespace)
            && self.editor.cursor == self.editor.text.len()
            && self.command_dismissed.as_ref() != Some(&self.editor.text)
    }
    pub(super) fn command_candidates(&self) -> Vec<&'static Command> {
        if !self.palette_open() {
            return vec![];
        }
        COMMANDS
            .iter()
            .filter(|c| c.name.starts_with(&self.editor.text[1..]))
            .collect()
    }
    pub(super) fn command_key(
        &mut self,
        key: KeyEvent,
        backend: &dyn HarnessBackend,
    ) -> Option<bool> {
        if !self.palette_open()
            || key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL | KeyModifiers::SHIFT)
        {
            return None;
        }
        let candidates = self.command_candidates();
        match key.code {
            KeyCode::Up => {
                self.command_selected = self
                    .command_selected
                    .min(candidates.len().saturating_sub(1))
                    .saturating_sub(1)
            }
            KeyCode::Down => {
                self.command_selected =
                    (self.command_selected + 1).min(candidates.len().saturating_sub(1))
            }
            KeyCode::Esc => self.command_dismissed = Some(self.editor.text.clone()),
            KeyCode::Tab | KeyCode::Enter
                if !candidates.is_empty() && key.kind == KeyEventKind::Press =>
            {
                let selected = candidates[self.command_selected.min(candidates.len() - 1)];
                // An exact command wins over a previous selection left over from another prefix.
                let selected = candidates
                    .iter()
                    .find(|c| self.editor.text == format!("/{}", c.name))
                    .copied()
                    .unwrap_or(selected);
                self.editor.text = format!("/{}", selected.name);
                if key.code == KeyCode::Tab {
                    if matches!(selected.name, "model" | "mode" | "plan" | "permission") {
                        self.editor.text.push(' ');
                    }
                    self.editor.cursor = self.editor.text.len();
                    self.command_dismissed = Some(self.editor.text.clone());
                } else {
                    self.editor.cursor = self.editor.text.len();
                    return Some(self.submit(backend));
                }
            }
            _ => return None,
        }
        Some(false)
    }
    pub(super) fn execute_command(
        &mut self,
        command: Invocation,
        backend: &dyn HarnessBackend,
    ) -> Option<bool> {
        let snapshot = backend.snapshot();
        if matches!(
            command,
            Invocation::Sessions | Invocation::Plugins | Invocation::Settings
        ) && snapshot["backend"] != "dsh"
        {
            self.notice = "このコマンドはDSHバックエンド専用です".into();
            return None;
        }
        let busy = matches!(snapshot["status"].as_str(), Some("running" | "approval"));
        if busy
            && matches!(
                command,
                Invocation::Models
                    | Invocation::Model(..)
                    | Invocation::Mode(..)
                    | Invocation::Plan(..)
                    | Invocation::Permission(..)
                    | Invocation::New
                    | Invocation::Sessions
            )
        {
            self.notice = "実行中は変更できません。/cancel で中止してから操作してください".into();
            return None;
        }
        self.notice.clear();
        match command {
            Invocation::Quit => return Some(true),
            Invocation::Help => self.open_details(Overlay::Help),
            Invocation::Status => self.open_details(Overlay::Status),
            Invocation::Diagnostics => self.open_details(Overlay::Diagnostics),
            Invocation::Logs => self.open_details(Overlay::Logs),
            Invocation::New => self.overlay = Overlay::New { confirm: false },
            Invocation::Models => {
                let selected = self
                    .models
                    .iter()
                    .position(|m| {
                        Some(m.provider.as_str()) == snapshot["provider"].as_str()
                            && Some(m.id.as_str()) == snapshot["model"].as_str()
                    })
                    .unwrap_or(0);
                self.overlay = Overlay::Models {
                    query: Editor::default(),
                    selected,
                };
            }
            Invocation::Model(provider, model) => {
                if !self.call(
                    "/api/model",
                    json!({"provider":provider,"model":model}),
                    backend,
                ) {
                    return None;
                }
            }
            Invocation::Mode(None) | Invocation::Permission(None) => {
                match backend.request("/api/controls", json!({})) {
                    Ok(value) => self.open_details(Overlay::ReadOnly {
                        title: " モード・パーミッション ",
                        content: controls_content(&value),
                    }),
                    Err(error) => {
                        self.notice = backend.redact(&error.to_string());
                        return None;
                    }
                }
            }
            Invocation::Mode(Some(mode)) => {
                if !self.change_control("/api/mode", json!({"mode":mode}), backend) {
                    return None;
                }
            }
            Invocation::Plan(value) => {
                let on = if let Some(on) = value {
                    on
                } else {
                    let controls = match backend.request("/api/controls", json!({})) {
                        Ok(value) => value,
                        Err(error) => {
                            self.notice = backend.redact(&error.to_string());
                            return None;
                        }
                    };
                    let active = match controls["mode"].as_str() {
                        Some("plan") => true,
                        Some("normal") => false,
                        _ => {
                            self.notice="計画状態を取得できません。/mode plan または /mode normal を指定してください".into();
                            return None;
                        }
                    };
                    if controls["planPending"] == true {
                        active
                    } else {
                        !active
                    }
                };
                if !self.change_control(
                    "/api/mode",
                    json!({"mode":if on {"plan"}else{"normal"}}),
                    backend,
                ) {
                    return None;
                }
            }
            Invocation::Permission(Some(preset)) => {
                let controls = match backend.request("/api/controls", json!({})) {
                    Ok(value) => value,
                    Err(error) => {
                        self.notice = backend.redact(&error.to_string());
                        return None;
                    }
                };
                let Some(row) = controls["permissions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|r| r["id"] == preset && r["selectable"] != false)
                else {
                    self.notice="選択可能な権限プリセットではありません。/permission で候補を確認してください".into();
                    return None;
                };
                let description = format!(
                    "{}: {}",
                    row["name"].as_str().unwrap_or(&preset),
                    row["description"]
                        .as_str()
                        .unwrap_or("権限プリセットを変更します")
                );
                self.open_details(Overlay::Permission {
                    preset,
                    description,
                    confirm: false,
                });
            }
            Invocation::Cancel => backend.cancel(),
            Invocation::Sessions => {
                match backend
                    .request("/api/sessions", json!({}))
                    .and_then(session_rows)
                {
                    Ok((items, truncated)) => {
                        self.overlay = Overlay::Sessions { items, selected: 0 };
                        if truncated {
                            self.notice = "セッション一覧は先頭256件のみ表示しています".into();
                        }
                    }
                    Err(error) => self.notice = backend.redact(&error.to_string()),
                }
                // The draft is retained until a selected session actually resumes.
                return None;
            }
            Invocation::Plugins | Invocation::Settings => {
                let (path, title) = if matches!(command, Invocation::Plugins) {
                    ("/api/plugins", " DSH プラグイン · 読み取り専用 ")
                } else {
                    ("/api/settings", " DSH 設定 · 読み取り専用 ")
                };
                match backend.request(path, json!({})) {
                    Ok(mut value) => {
                        redact_json_fields(&mut value);
                        let mut content = backend
                            .redact(&serde_json::to_string_pretty(&value).unwrap_or_default());
                        const LIMIT: usize = 256 * 1024;
                        if content.len() > LIMIT {
                            let mut end = LIMIT;
                            while !content.is_char_boundary(end) {
                                end -= 1;
                            }
                            content.truncate(end);
                            content.push_str("\n\n[表示上限256KiBに達したため省略しました]");
                            self.notice = "読み取り専用情報を表示上限256KiBで省略しました".into();
                        }
                        self.open_details(Overlay::ReadOnly { title, content });
                    }
                    Err(error) => {
                        self.notice = backend.redact(&error.to_string());
                        return None;
                    }
                }
            }
        }
        Some(false)
    }
    pub(super) fn change_control(
        &mut self,
        path: &str,
        body: Value,
        backend: &dyn HarnessBackend,
    ) -> bool {
        match backend.request(path, body) {
            Ok(value) => {
                self.notice = backend.redact(
                    value["message"]
                        .as_str()
                        .unwrap_or("モード・パーミッションを変更しました"),
                );
                true
            }
            Err(error) => {
                self.notice = backend.redact(&error.to_string());
                false
            }
        }
    }
    pub(super) fn new_chat(&mut self, backend: &dyn HarnessBackend) -> bool {
        if let Err(error) = backend.reset() {
            self.notice = backend.redact(&error.to_string());
            return false;
        }
        self.history.clear();
        self.history_index = None;
        self.saved_draft.clear();
        self.scroll = 0;
        self.follow = true;
        self.notice = "新しい会話を開始しました".into();
        true
    }
}
fn session_rows(value: Value) -> Result<(Vec<SessionRow>, bool)> {
    let items = value["items"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("セッション一覧の形式が不正です"))?;
    let mut rows = Vec::new();
    for item in items.iter().take(256) {
        let id = item["id"]
            .as_str()
            .filter(|id| {
                !id.trim().is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
            })
            .ok_or_else(|| anyhow::anyhow!("セッションIDが不正です"))?;
        rows.push(SessionRow {
            id: id.into(),
            title: item["title"]
                .as_str()
                .unwrap_or("（無題）")
                .chars()
                .take(4096)
                .collect(),
            cwd: item["cwd"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(4096)
                .collect(),
        });
    }
    Ok((rows, items.len() > 256))
}
fn redact_json_fields(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (name, value) in fields {
                let key = name
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .collect::<String>()
                    .to_ascii_lowercase();
                if key == "key"
                    || key.ends_with("apikey")
                    || key.ends_with("privatekey")
                    || key.ends_with("token")
                    || key.contains("password")
                    || key.contains("secret")
                    || key.contains("credential")
                    || key == "authorization"
                {
                    *value = json!("[REDACTED]");
                } else {
                    redact_json_fields(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_json_fields),
        _ => {}
    }
}
fn controls_content(value: &Value) -> String {
    let mut lines = vec![
        format!(
            "動作モード: {}{}",
            value["mode"].as_str().unwrap_or("未対応／未取得"),
            if value["planPending"] == true {
                "（切替待ち）"
            } else {
                ""
            }
        ),
        format!(
            "パーミッション: {}",
            value["permission"].as_str().unwrap_or("未対応／未取得")
        ),
        String::new(),
        "/mode normal または /mode plan、/plan [on|off] で切り替え".into(),
    ];
    for mode in value["modes"].as_array().into_iter().flatten() {
        lines.push(format!(
            "/mode {} — {}",
            mode["id"].as_str().unwrap_or(""),
            mode["description"].as_str().unwrap_or("")
        ));
    }
    lines.push(String::new());
    lines.push("/permission PRESET は内容を確認してから適用します".into());
    for row in value["permissions"].as_array().into_iter().flatten() {
        lines.push(format!(
            "/permission {} — {}{}",
            row["id"].as_str().unwrap_or(""),
            row["description"].as_str().unwrap_or(""),
            if row["selectable"] == false {
                "（表示のみ）"
            } else {
                ""
            }
        ));
    }
    if value["modes"].as_array().is_none_or(Vec::is_empty) {
        lines.push("このバックエンド構成にPlan操作はありません".into());
    }
    if value["permissions"].as_array().is_none_or(Vec::is_empty) {
        lines.push("このバックエンド構成に選択可能な権限設定はありません".into());
    }
    lines.push("設定変更は実行停止中のみ。未知のコマンドはモデルへ送りません。".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parsing_is_strict_and_literal_slashes_are_supported() {
        assert_eq!(parse("/model").unwrap().unwrap(), Invocation::Models);
        assert_eq!(
            parse(" /model dsh:test example ").unwrap().unwrap(),
            Invocation::Model("dsh:test".into(), "example".into())
        );
        assert!(parse("/unknown").unwrap().is_err());
        assert!(parse("/quit extra").unwrap().is_err());
        assert!(parse("/model only-provider").unwrap().is_err());
        assert!(parse("/help\n/quit").unwrap().is_err());
        assert!(parse("//path/to/file").is_none());
        assert!(parse("normal text").is_none());
        for c in COMMANDS {
            assert!(parse(&format!("/{}", c.name)).unwrap().is_ok());
        }
    }
}
