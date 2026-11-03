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
];
#[derive(Debug, PartialEq)]
pub(super) enum Invocation {
    Help,
    Models,
    Model(String, String),
    New,
    Status,
    Logs,
    Cancel,
    Quit,
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
            "status" => Invocation::Status,
            "logs" => Invocation::Logs,
            "cancel" => Invocation::Cancel,
            "quit" => Invocation::Quit,
            _ => unreachable!(),
        })
    })())
}
impl App {
    pub(super) fn palette_open(&self) -> bool {
        matches!(self.overlay, Overlay::None)
            && self.pending_id.is_none()
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
        engine: &Arc<Engine>,
        runtime: &Arc<Runtime>,
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
                    return Some(self.submit(engine, runtime));
                }
            }
            _ => return None,
        }
        Some(false)
    }
    pub(super) fn execute_command(
        &mut self,
        command: Invocation,
        engine: &Arc<Engine>,
        runtime: &Arc<Runtime>,
    ) -> Option<bool> {
        let busy = matches!(
            engine.state.lock().unwrap().status.as_str(),
            "running" | "approval"
        );
        if busy
            && matches!(
                command,
                Invocation::Models | Invocation::Model(..) | Invocation::New
            )
        {
            self.notice = "実行中は変更できません。/cancel で中止してから操作してください".into();
            return None;
        }
        self.notice.clear();
        match command {
            Invocation::Quit => return Some(true),
            Invocation::Help => self.overlay = Overlay::Help,
            Invocation::Status => self.overlay = Overlay::Status,
            Invocation::Logs => self.overlay = Overlay::Logs,
            Invocation::New => self.overlay = Overlay::New { confirm: false },
            Invocation::Models => {
                let state = engine.state.lock().unwrap();
                let selected = self
                    .models
                    .iter()
                    .position(|m| m.provider == state.provider && m.id == state.model)
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
                    engine,
                    runtime,
                ) {
                    return None;
                }
            }
            Invocation::Cancel => engine.cancel(),
        }
        Some(false)
    }
    pub(super) fn new_chat(&mut self, engine: &Engine) -> bool {
        let mut state = engine.state.lock().unwrap();
        if matches!(state.status.as_str(), "running" | "approval") {
            self.notice = "実行中は新しい会話を開始できません".into();
            return false;
        }
        state.run_id += 1;
        state.messages.clear();
        state.events.clear();
        state.error = None;
        state.status = "idle".into();
        self.history.clear();
        self.history_index = None;
        self.saved_draft.clear();
        self.scroll = 0;
        self.follow = true;
        self.notice = "新しい会話を開始しました".into();
        true
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
