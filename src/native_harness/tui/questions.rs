//! Explicit, bounded answers to DSH user-question requests.
use super::{
    edit,
    editor::{clean, Editor},
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_FORM_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
pub(super) struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct Question {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(rename = "multiSelect", default)]
    pub multi_select: bool,
    #[serde(default)]
    pub intent: Option<Value>,
    #[serde(skip)]
    pub selected: Vec<bool>,
    #[serde(skip)]
    pub custom: Editor,
}

pub(super) struct QuestionForm {
    source: Value,
    pub items: Vec<Question>,
    pub current: usize,
    pub focused: usize,
    pub editing: bool,
    pub scroll: usize,
    pub max_scroll: usize,
    pub follow_focus: bool,
}

pub(super) fn data(pending: &Value) -> &Value {
    pending
        .get("questions")
        .unwrap_or(&pending["arguments"]["questions"])
}

fn valid_label(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

impl QuestionForm {
    pub fn parse(source: &Value) -> Result<Self> {
        if serde_json::to_vec(source)?.len() > MAX_FORM_BYTES {
            bail!("質問が上限256KiBを超えています。Escで中止してください");
        }
        let mut items: Vec<Question> =
            serde_json::from_value(source.clone()).context("質問の形式が不正です")?;
        if items.is_empty() || items.len() > 32 {
            bail!("質問数は1〜32件である必要があります");
        }
        let mut ids = HashSet::new();
        for q in &mut items {
            if !valid_label(&q.id, 512)
                || !ids.insert(q.id.clone())
                || clean(&q.question).trim().is_empty()
                || q.options.len() > 64
            {
                bail!("質問ID・本文・選択肢数が不正です");
            }
            let mut labels = HashSet::new();
            if q.options
                .iter()
                .any(|o| !valid_label(&o.label, 4096) || !labels.insert(o.label.clone()))
            {
                bail!("選択肢のラベルが空・重複・上限超過または制御文字を含んでいます");
            }
            if let Some(intent) = &q.intent {
                if !intent.is_object() || intent["kind"].as_str().is_none() {
                    bail!("質問のintentが不正です");
                }
                if intent["kind"] == "plan-review"
                    && (q
                        .detail
                        .as_deref()
                        .is_none_or(|s| clean(s).trim().is_empty())
                        || !q
                            .options
                            .iter()
                            .any(|o| Some(o.label.as_str()) == intent["approve"].as_str()))
                {
                    bail!("計画レビューには計画本文と実在する承認ラベルが必要です");
                }
            }
            q.selected = vec![false; q.options.len()];
        }
        Ok(Self {
            source: source.clone(),
            items,
            current: 0,
            focused: 0,
            editing: false,
            scroll: 0,
            max_scroll: 0,
            follow_focus: false,
        })
    }

    pub fn matches(&self, source: &Value) -> bool {
        &self.source == source
    }

    pub fn clear_answers(&mut self) {
        for q in &mut self.items {
            q.selected.fill(false);
            q.custom.clear();
        }
        self.editing = false;
    }

    pub fn paste(&mut self, value: &str) -> bool {
        if !self.editing {
            return true;
        }
        let q = &mut self.items[self.current];
        let inserted = q.custom.insert(value);
        if inserted && !q.multi_select && !q.custom.text.trim().is_empty() {
            q.selected.fill(false);
        }
        self.follow_focus = true;
        inserted
    }

    /// Enter never selects or submits; Ctrl+S is the sole submit action.
    pub fn key(&mut self, key: KeyEvent) -> Result<Option<Value>> {
        if key.kind != KeyEventKind::Press {
            return Ok(None);
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('s') {
            return self.answers().map(Some);
        }
        if ctrl && key.code == KeyCode::Char('e') {
            self.editing = !self.editing;
            self.follow_focus = true;
            return Ok(None);
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::BackTab) {
            let previous =
                key.code == KeyCode::BackTab || key.modifiers.contains(KeyModifiers::SHIFT);
            self.current = if previous {
                (self.current + self.items.len() - 1) % self.items.len()
            } else {
                (self.current + 1) % self.items.len()
            };
            self.focused = 0;
            self.editing = false;
            self.scroll = 0;
            self.follow_focus = false;
            return Ok(None);
        }
        match key.code {
            KeyCode::PageUp | KeyCode::PageDown => {
                self.scroll = self
                    .scroll
                    .saturating_add_signed(if key.code == KeyCode::PageUp { -8 } else { 8 })
                    .min(self.max_scroll);
                self.follow_focus = false;
                return Ok(None);
            }
            KeyCode::Home | KeyCode::End if !self.editing => {
                self.scroll = if key.code == KeyCode::Home {
                    0
                } else {
                    self.max_scroll
                };
                self.follow_focus = false;
                return Ok(None);
            }
            _ => {}
        }
        let q = &mut self.items[self.current];
        if self.editing {
            if key.code != KeyCode::Enter && !edit(&mut q.custom, key) {
                bail!("自由入力は16KiB以内にしてください");
            }
            if !q.multi_select && !q.custom.text.trim().is_empty() {
                q.selected.fill(false);
            }
            self.follow_focus = true;
        } else {
            match key.code {
                KeyCode::Up | KeyCode::Left => self.focused = self.focused.saturating_sub(1),
                KeyCode::Down | KeyCode::Right => {
                    self.focused = (self.focused + 1).min(q.options.len().saturating_sub(1))
                }
                KeyCode::Char(' ')
                    if !ctrl
                        && !key.modifiers.contains(KeyModifiers::ALT)
                        && !q.options.is_empty() =>
                {
                    let selected = !q.selected[self.focused];
                    if !q.multi_select {
                        q.selected.fill(false);
                        q.custom.clear();
                    }
                    q.selected[self.focused] = selected;
                }
                _ => return Ok(None),
            }
            self.follow_focus = true;
        }
        Ok(None)
    }

    fn answers(&self) -> Result<Value> {
        let mut answers = Vec::new();
        for q in &self.items {
            let selected = q
                .options
                .iter()
                .zip(&q.selected)
                .filter(|(_, selected)| **selected)
                .map(|(o, _)| o.label.as_str())
                .collect::<Vec<_>>();
            let custom = q.custom.text.trim();
            if selected.is_empty() && custom.is_empty() {
                bail!("未回答の質問があります。Spaceで選択またはCtrl+Eで自由入力してください");
            }
            let mut answer = json!({"id":q.id,"selected":selected});
            if !custom.is_empty() {
                answer["custom"] = json!(q.custom.text);
            }
            answers.push(answer);
        }
        let answers = json!(answers);
        if serde_json::to_vec(&answers)?.len() > MAX_FORM_BYTES {
            bail!("回答全体が上限256KiBを超えています");
        }
        Ok(answers)
    }
}
