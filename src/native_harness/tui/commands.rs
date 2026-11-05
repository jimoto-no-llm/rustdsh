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
];
#[derive(Debug, PartialEq)]
pub(super) enum Invocation {
    Help,
    Models,
    Model(String, String),
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
        if parts.len() != 1 {
            bail!("使い方: {}", command.usage);
        }
        Ok(match command.name {
            "help" => Invocation::Help,
            "model" | "models" => Invocation::Models,
            "new" => Invocation::New,
            "status" | "usage" => Invocation::Status,
            "diagnostics" => Invocation::Diagnostics,
            "logs" => Invocation::Logs,
            "cancel" => Invocation::Cancel,
            "quit" => Invocation::Quit,
            "sessions" => Invocation::Sessions,
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
                    if selected.name == "model" {
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
                Invocation::Models | Invocation::Model(..) | Invocation::New | Invocation::Sessions
            )
        {
            self.notice = "実行中は変更できません。/cancel で中止してから操作してください".into();
            return None;
        }
        self.notice.clear();
        match command {
            Invocation::Quit => return Some(true),
            Invocation::Help => self.overlay = Overlay::Help,
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
