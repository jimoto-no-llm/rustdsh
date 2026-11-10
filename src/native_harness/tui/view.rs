//! Cell-aware rendering; model/tool text is always rendered as inert text.
use super::{
    editor::{clean, wrap},
    App, Overlay,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{
        Block, Borders, Clear, List, ListItem, ListState, Paragraph, Scrollbar,
        ScrollbarOrientation, ScrollbarState,
    },
    Frame,
};
use serde_json::Value;
use std::time::Duration;
const ACCENT: Color = Color::Cyan;
const MUTED: Color = Color::DarkGray;
const APPROVAL: Color = Color::Yellow;
fn block(title: &str) -> Block<'_> {
    Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(Style::default().fg(MUTED))
}
fn text(value: &Value) -> String {
    clean(value.as_str().unwrap_or(""))
}
fn lines(value: &str, width: u16, style: Style) -> Vec<Line<'static>> {
    wrap(&clean(value), width, usize::MAX)
        .0
        .into_iter()
        .map(|s| Line::styled(s, style))
        .collect()
}
fn popup(area: Rect, width: u16, height: u16) -> Rect {
    let w = width.min(area.width.saturating_sub(2));
    let h = height.min(area.height.saturating_sub(2));
    Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    )
}
pub(super) fn draw(frame: &mut Frame, app: &mut App, snapshot: &Value, elapsed: Duration) {
    let area = frame.area();
    if area.width < 42 || area.height < 14 {
        frame.render_widget(Paragraph::new("RDSH Native TUI\n端末を42列×14行以上に広げてください\nCtrl+Q 終了 / Ctrl+C 実行中止"),area);
        return;
    }
    let input_height = wrap(
        &app.editor.text,
        area.width.saturating_sub(4),
        app.editor.cursor,
    )
    .0
    .len()
    .clamp(2, 6) as u16
        + 2;
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(3),
            Constraint::Length(input_height.min(area.height / 3)),
            Constraint::Length(2),
        ])
        .split(area);
    let status = match snapshot["status"].as_str() {
        Some("running") => ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
            [(elapsed.as_millis() / 100 % 10) as usize],
        Some("approval") => "承認待ち",
        Some("error") => "エラー",
        _ => "待機中",
    };
    let header = vec![
        Line::from(vec![
            Span::styled(
                " RDSH ",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
            Span::raw("Native TUI  "),
            Span::styled(
                status,
                Style::default().fg(if app.pending_id.is_some() {
                    APPROVAL
                } else {
                    Color::Green
                }),
            ),
            Span::raw(format!(
                "    {} / {}",
                text(&snapshot["provider"]),
                text(&snapshot["model"])
            )),
        ]),
        Line::styled(
            format!(" {}", text(&snapshot["workspace"])),
            Style::default().fg(MUTED),
        ),
    ];
    frame.render_widget(
        Paragraph::new(header).block(Block::default().borders(Borders::BOTTOM)),
        rows[0],
    );
    let columns = if app.show_activity && area.width >= 110 {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(60), Constraint::Length(34)])
            .split(rows[1])
            .to_vec()
    } else {
        vec![rows[1]]
    };
    transcript(frame, app, snapshot, columns[0]);
    if columns.len() > 1 {
        activity(frame, snapshot, columns[1]);
    }
    let input_block = block(" メッセージ ").border_style(Style::default().fg(
        if matches!(app.overlay, Overlay::None) && app.pending_id.is_none() {
            ACCENT
        } else {
            MUTED
        },
    ));
    let input = input_block.inner(rows[2]);
    frame.render_widget(input_block, rows[2]);
    let (wrapped, (cx, cy)) = wrap(
        &app.editor.text,
        input.width.saturating_sub(1),
        app.editor.cursor,
    );
    let start = cy.saturating_sub(input.height.saturating_sub(1));
    if app.editor.text.is_empty() {
        frame.render_widget(
            Paragraph::new("メッセージを入力…  Enter 送信 / Alt+Enter 改行")
                .style(Style::default().fg(MUTED)),
            input,
        );
    } else {
        frame.render_widget(
            Paragraph::new(
                wrapped
                    .into_iter()
                    .skip(start as usize)
                    .map(Line::from)
                    .collect::<Vec<_>>(),
            ),
            input,
        );
    }
    if matches!(app.overlay, Overlay::None) && app.pending_id.is_none() {
        frame.set_cursor_position((
            input.x + cx.min(input.width.saturating_sub(1)),
            input.y + cy.saturating_sub(start).min(input.height.saturating_sub(1)),
        ));
    }
    let notice = if !app.notice.is_empty() {
        app.notice.clone()
    } else if !snapshot["error"].is_null() {
        text(&snapshot["error"])
    } else {
        format!(
            "{} B / 16 KiB  │  {}",
            app.editor.text.len(),
            if app.follow {
                "最新を表示"
            } else {
                "履歴を閲覧中 · Ctrl+Endで最新へ"
            }
        )
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled(
                clean(&notice),
                Style::default().fg(if app.notice.is_empty() && snapshot["error"].is_null() {
                    MUTED
                } else {
                    Color::Yellow
                }),
            ),
            Line::raw("F1 ヘルプ  F2 モデル  F3 実行ログ  PgUp/Dn 履歴  Esc 中止  Ctrl+Q 終了"),
        ]),
        rows[3],
    );
    if app.palette_open() {
        command_palette(
            frame,
            app,
            snapshot,
            Rect::new(rows[1].x, rows[1].y, rows[1].width, rows[1].height),
        );
    }
    if app.pending_id.is_some() {
        approval(frame, app, snapshot, area);
    } else {
        match &app.overlay {
            Overlay::Models { .. } => models(frame, app, area),
            Overlay::Help => help(frame, area),
            Overlay::Status => status_panel(frame, snapshot, area),
            Overlay::Logs => {
                let panel = popup(area, 96, 26);
                frame.render_widget(Clear, panel);
                activity(frame, snapshot, panel);
            }
            Overlay::New { confirm } => new_chat(frame, *confirm, area),
            _ => {}
        }
    }
}
fn transcript(frame: &mut Frame, app: &mut App, snapshot: &Value, area: Rect) {
    let border = block(" 会話 ");
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let mut content = Vec::new();
    let width = inner.width.saturating_sub(1).max(2);
    if let Some(messages) = snapshot["messages"].as_array() {
        for message in messages {
            let (label, color) = match message["role"].as_str() {
                Some("user") => ("あなた", ACCENT),
                Some("assistant") => ("アシスタント", Color::Green),
                _ => ("ツール結果", MUTED),
            };
            content.push(Line::styled(
                format!(" {label}"),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ));
            let mut code = false;
            for raw in text(&message["content"]).split('\n') {
                if raw.trim_start().starts_with("```") {
                    code = !code;
                }
                let style = if code || raw.trim_start().starts_with("```") {
                    Style::default().fg(Color::Yellow)
                } else {
                    Style::default()
                };
                content.extend(lines(raw, width, style));
            }
            content.push(Line::raw(""));
        }
    }
    if content.is_empty() {
        content = vec![
            Line::raw(""),
            Line::styled(
                "Rustdshへようこそ",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
            Line::raw(""),
            Line::raw("このワークスペースでの相談を入力してください。"),
            Line::raw("F2でモデル選択、F1で操作方法を確認できます。"),
            Line::raw("ファイル読み取り・Devin実行は内容を確認して承認します。"),
        ];
    }
    if snapshot["status"] == "running" {
        content.push(Line::styled(
            "応答を生成しています…  Escで中止",
            Style::default().fg(ACCENT),
        ));
    }
    app.max_scroll = content.len().saturating_sub(inner.height as usize);
    app.scroll = if app.follow {
        app.max_scroll
    } else {
        app.scroll.min(app.max_scroll)
    };
    let total = content.len();
    frame.render_widget(
        Paragraph::new(
            content
                .into_iter()
                .skip(app.scroll)
                .take(inner.height as usize)
                .collect::<Vec<_>>(),
        ),
        inner,
    );
    let mut state = ScrollbarState::new(total)
        .position(app.scroll)
        .viewport_content_length(inner.height as usize);
    frame.render_stateful_widget(
        Scrollbar::new(ScrollbarOrientation::VerticalRight),
        area.inner(ratatui::layout::Margin::new(0, 1)),
        &mut state,
    );
}
fn activity(frame: &mut Frame, snapshot: &Value, area: Rect) {
    let border = block(" 実行ログ ");
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let mut content = Vec::new();
    for event in snapshot["events"].as_array().into_iter().flatten() {
        content.push(Line::styled(
            format!("{} / {}", text(&event["kind"]), text(&event["name"])),
            Style::default().fg(ACCENT),
        ));
        content.extend(lines(
            &text(&event["content"]),
            inner.width,
            Style::default().fg(MUTED),
        ));
        content.push(Line::raw(""));
    }
    let start = content.len().saturating_sub(inner.height as usize);
    frame.render_widget(
        Paragraph::new(content.into_iter().skip(start).collect::<Vec<_>>()),
        inner,
    );
}
fn approval(frame: &mut Frame, app: &mut App, snapshot: &Value, area: Rect) {
    let area = popup(area, 96, 24);
    frame.render_widget(Clear, area);
    let border = block(" 操作の承認 · 一回限り ").border_style(Style::default().fg(APPROVAL));
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(1),
            Constraint::Length(2),
        ])
        .split(inner);
    frame.render_widget(
        Paragraph::new(format!(
            "{}\n{}",
            text(&snapshot["pending"]["tool"]),
            text(&snapshot["pending"]["reason"])
        ))
        .style(Style::default().fg(APPROVAL)),
        rows[0],
    );
    let body = format!(
        "{}\n\nID: {}",
        serde_json::to_string_pretty(&snapshot["pending"]["arguments"]).unwrap_or_default(),
        text(&snapshot["pending"]["id"])
    );
    let body = lines(&body, rows[1].width.saturating_sub(1), Style::default());
    app.approval_scroll = app.approval_scroll.min(
        body.len()
            .saturating_sub(rows[1].height as usize)
            .min(u16::MAX as usize) as u16,
    );
    frame.render_widget(
        Paragraph::new(body).scroll((app.approval_scroll, 0)),
        rows[1],
    );
    let selected = Style::default()
        .bg(APPROVAL)
        .fg(Color::Black)
        .add_modifier(Modifier::BOLD);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(
                    " 拒否 ",
                    if !app.allow {
                        selected
                    } else {
                        Style::default()
                    },
                ),
                Span::raw("    "),
                Span::styled(
                    " 一度だけ許可 ",
                    if app.allow {
                        selected
                    } else {
                        Style::default()
                    },
                ),
            ]),
            Line::styled(
                "Tab/←→ 選択  Enter 確定  Esc 拒否  ↑↓/PgUp/Dn 詳細",
                Style::default().fg(MUTED),
            ),
        ]),
        rows[2],
    );
}
fn models(frame: &mut Frame, app: &App, area: Rect) {
    let area = popup(area, 90, 24);
    frame.render_widget(Clear, area);
    let border = block(" モデルを選択 ").border_style(Style::default().fg(ACCENT));
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(1),
            Constraint::Length(2),
        ])
        .split(inner);
    let (query, selected) = match &app.overlay {
        Overlay::Models { query, selected } => (query, *selected),
        _ => return,
    };
    let available = app.filtered_models();
    let search = format!("絞り込み: {}", query.text);
    let (search_lines, (cursor_x, cursor_y)) = wrap(
        &search,
        rows[0].width.saturating_sub(1),
        "絞り込み: ".len() + query.cursor,
    );
    let search_start = cursor_y.saturating_sub(1);
    frame.render_widget(
        Paragraph::new(
            search_lines
                .into_iter()
                .skip(search_start as usize)
                .map(Line::from)
                .collect::<Vec<_>>(),
        )
        .block(Block::default().borders(Borders::BOTTOM)),
        rows[0],
    );
    let items = available
        .iter()
        .map(|m| {
            ListItem::new(format!(
                "{} / {}{}",
                m.provider,
                m.id,
                if m.unavailable.is_some() {
                    "  [利用不可]"
                } else {
                    ""
                }
            ))
            .style(Style::default().fg(if m.unavailable.is_some() {
                MUTED
            } else {
                Color::Reset
            }))
        })
        .collect::<Vec<_>>();
    let mut state =
        ListState::default().with_selected(Some(selected.min(items.len().saturating_sub(1))));
    frame.render_stateful_widget(
        List::new(items)
            .highlight_style(Style::default().fg(Color::Black).bg(ACCENT))
            .highlight_symbol("› "),
        rows[1],
        &mut state,
    );
    let reason = available
        .get(selected)
        .and_then(|m| m.unavailable.as_deref())
        .unwrap_or("↑↓ 選択  Enter 決定  Esc 戻る");
    frame.render_widget(
        Paragraph::new(vec![
            Line::raw(format!("{} 件", available.len())),
            Line::styled(clean(reason), Style::default().fg(MUTED)),
        ]),
        rows[2],
    );
    frame.set_cursor_position((
        rows[0].x + cursor_x.min(rows[0].width.saturating_sub(1)),
        rows[0].y + cursor_y.saturating_sub(search_start).min(1),
    ));
}
fn command_palette(frame: &mut Frame, app: &App, snapshot: &Value, above: Rect) {
    let candidates = app.command_candidates();
    let height = (candidates.len().max(1) as u16 + 2).min(above.height);
    if height < 3 {
        return;
    }
    let area = Rect::new(
        above.x,
        above.y + above.height - height,
        above.width.min(88),
        height,
    );
    frame.render_widget(Clear, area);
    let busy = matches!(snapshot["status"].as_str(), Some("running" | "approval"));
    let items = if candidates.is_empty() {
        vec![ListItem::new(
            "一致するコマンドがありません · /help で操作方法",
        )]
    } else {
        candidates
            .iter()
            .map(|c| {
                let blocked = busy && c.needs_idle;
                ListItem::new(format!(
                    "/{:<8} {}{}",
                    c.name,
                    c.description,
                    if blocked { " [実行中は不可]" } else { "" }
                ))
                .style(Style::default().fg(if blocked {
                    MUTED
                } else {
                    Color::Reset
                }))
            })
            .collect()
    };
    let mut state = ListState::default().with_selected(Some(
        app.command_selected.min(items.len().saturating_sub(1)),
    ));
    frame.render_stateful_widget(
        List::new(items)
            .block(
                block(" / コマンド · ↑↓ 選択 · Tab 補完 · Enter 実行 ")
                    .border_style(Style::default().fg(ACCENT)),
            )
            .highlight_symbol("› ")
            .highlight_style(Style::default().fg(Color::Black).bg(ACCENT)),
        area,
        &mut state,
    );
}
fn status_panel(frame: &mut Frame, snapshot: &Value, area: Rect) {
    let area = popup(area, 86, 18);
    frame.render_widget(Clear, area);
    let mut content = vec![
        Line::raw(format!("状態: {}", text(&snapshot["status"]))),
        Line::raw(format!(
            "モデル: {} / {}",
            text(&snapshot["provider"]),
            text(&snapshot["model"])
        )),
    ];
    content.extend(lines(
        &format!("作業場所: {}", text(&snapshot["workspace"])),
        area.width.saturating_sub(2),
        Style::default(),
    ));
    content.push(Line::raw(format!(
        "会話: {} メッセージ / 実行ログ: {} 件",
        snapshot["messages"].as_array().map(Vec::len).unwrap_or(0),
        snapshot["events"].as_array().map(Vec::len).unwrap_or(0)
    )));
    content.push(Line::raw(""));
    content.push(Line::styled(
        "会話はメモリー内で保持。保存・再開は未対応です。",
        Style::default().fg(MUTED),
    ));
    content.extend(lines(
        &text(&snapshot["error"]),
        area.width.saturating_sub(2),
        Style::default().fg(Color::Yellow),
    ));
    content.push(Line::raw(""));
    content.push(Line::raw("Esc / Enter で閉じる"));
    frame.render_widget(
        Paragraph::new(content).block(block(" 状態 ").border_style(Style::default().fg(ACCENT))),
        area,
    );
}
fn new_chat(frame: &mut Frame, confirm: bool, area: Rect) {
    let area = popup(area, 76, 10);
    frame.render_widget(Clear, area);
    let selected = Style::default()
        .fg(Color::Black)
        .bg(APPROVAL)
        .add_modifier(Modifier::BOLD);
    frame.render_widget(
        Paragraph::new(vec![
            Line::raw("現在の会話と入力履歴を消して、新しい会話を始めます。"),
            Line::raw("元の会話には戻れません。ファイルは変更しません。"),
            Line::raw(""),
            Line::from(vec![
                Span::styled(" 戻る ", if !confirm { selected } else { Style::default() }),
                Span::raw("    "),
                Span::styled(
                    " 新しい会話を開始 ",
                    if confirm { selected } else { Style::default() },
                ),
            ]),
            Line::raw(""),
            Line::raw("Tab / ←→ 選択  Enter 確定  Esc 戻る"),
        ])
        .block(block(" 新しい会話 ").border_style(Style::default().fg(APPROVAL))),
        area,
    );
}
fn help(frame: &mut Frame, area: Rect) {
    let area = popup(area, 86, 25);
    frame.render_widget(Clear, area);
    let mut content = vec![
        Line::raw("Enter 送信 / Alt+Enter・Ctrl+J 改行 / Ctrl+U 入力クリア"),
        Line::raw("PgUp/Dn 履歴 / Ctrl+Home/End 先頭・末尾 / Ctrl+P/N 送信履歴"),
        Line::raw("F2 モデル / F3 実行ログ / Ctrl+C 中止 / Ctrl+Q 終了"),
        Line::raw("承認: Tabで拒否・許可を選択、Enterで確定。Escで拒否。"),
        Line::raw(""),
        Line::styled(
            "/ で候補表示 · ↑↓ 選択 · Tab 補完 · Enter 実行",
            Style::default().fg(ACCENT),
        ),
    ];
    for c in super::commands::COMMANDS {
        content.push(Line::raw(format!("{}  {}", c.usage, c.description)));
    }
    content.extend([
        Line::raw(""),
        Line::raw("// で文章先頭の / を送信。未知のコマンドは送信しません。"),
        Line::raw("F1 / Esc / Enter で閉じる"),
    ]);
    frame.render_widget(
        Paragraph::new(content)
            .block(block(" 操作方法 ").border_style(Style::default().fg(ACCENT))),
        area,
    );
}
