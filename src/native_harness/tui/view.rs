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
    app.set_size(area.width, area.height);
    if !app.input_visible {
        frame.render_widget(
            Paragraph::new(
                "RDSH TUI\n端末を42列×14行以上に広げてください\nCtrl+Q 終了 / Ctrl+C 実行中止",
            ),
            area,
        );
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
            Constraint::Length(3),
        ])
        .split(area);
    let status = match snapshot["status"].as_str() {
        Some("running") => ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
            [(elapsed.as_millis() / 100 % 10) as usize],
        Some("approval") if app.pending_is_questions => "回答待ち",
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
            Span::raw(format!(
                "{}  ",
                clean(
                    snapshot["engine"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| snapshot["backend"].as_str())
                        .unwrap_or("TUI")
                )
            )),
            Span::styled(
                status,
                Style::default().fg(if app.has_pending() {
                    APPROVAL
                } else {
                    Color::Green
                }),
            ),
            Span::raw(controls_label(snapshot)),
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
        if matches!(app.overlay, Overlay::None) && !app.has_pending() {
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
    if matches!(app.overlay, Overlay::None) && !app.has_pending() {
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
            Line::styled(usage_line(&snapshot["usage"]), Style::default().fg(ACCENT)),
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
    if app.has_pending() {
        if app.pending_is_questions {
            question_panel(frame, app, area);
        } else {
            approval(frame, app, snapshot, area);
        }
    } else {
        match &app.overlay {
            Overlay::Terminal => {
                if let Some(pane) = &mut app.terminal {
                    pane.draw(frame, area);
                }
            }
            Overlay::Admin => {
                if let Some(panel) = &mut app.admin {
                    panel.draw(frame, area);
                }
            }
            Overlay::Models { .. } => models(frame, app, area),
            Overlay::Help => help(frame, app, area),
            Overlay::Status => status_panel(frame, app, snapshot, area),
            Overlay::Logs => log_panel(frame, app, snapshot, area),
            Overlay::Diagnostics => diagnostics(frame, app, snapshot, area),
            Overlay::Sessions { .. } => sessions(frame, app, area),
            Overlay::ReadOnly { .. } => readonly(frame, app, area),
            Overlay::New { confirm } => new_chat(frame, *confirm, snapshot, area),
            Overlay::Permission { .. } => permission_change(frame, app, area),
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
fn question_panel(frame: &mut Frame, app: &mut App, area: Rect) {
    let area = popup(area, 112, 30);
    frame.render_widget(Clear, area);
    let title = app
        .question_form
        .as_ref()
        .map(|f| format!(" 質問 {}/{} · 初期選択なし ", f.current + 1, f.items.len()))
        .unwrap_or_else(|| " 質問を表示できません · Esc 中止 ".into());
    let border = block(&title).border_style(Style::default().fg(APPROVAL));
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(3)])
        .split(inner);
    let Some(form) = &mut app.question_form else {
        let error = app
            .question_error
            .as_deref()
            .unwrap_or("質問の形式が不正です");
        frame.render_widget(
            Paragraph::new(lines(error, rows[0].width, Style::default().fg(APPROVAL))),
            rows[0],
        );
        frame.render_widget(
            Paragraph::new("回答を送信できません\nEsc 中止 / Ctrl+Q 終了"),
            rows[1],
        );
        return;
    };
    let q = &form.items[form.current];
    let width = rows[0].width.saturating_sub(1);
    let mut content = Vec::new();
    if let Some(header) = &q.header {
        content.extend(lines(header, width, Style::default().fg(ACCENT)));
    }
    content.extend(lines(
        &q.question,
        width,
        Style::default().add_modifier(Modifier::BOLD),
    ));
    if q.intent
        .as_ref()
        .is_some_and(|i| i["kind"] == "plan-review")
    {
        content.extend(lines(
            "計画レビュー: 内容を読み、選択してからCtrl+Sで送信してください。",
            width,
            Style::default().fg(APPROVAL),
        ));
    }
    if let Some(detail) = &q.detail {
        content.push(Line::raw(""));
        content.extend(lines(detail, width, Style::default()));
    }
    content.push(Line::raw(""));
    content.push(Line::styled(
        if q.multi_select {
            "複数選択可 · Spaceで選択/解除"
        } else {
            "単一選択 · Spaceで選択/解除"
        },
        Style::default().fg(MUTED),
    ));
    let mut focused_line = content.len();
    for (i, option) in q.options.iter().enumerate() {
        if i == form.focused && !form.editing {
            focused_line = content.len();
        }
        content.extend(lines(
            &format!(
                "{} [{}] {}",
                if i == form.focused && !form.editing {
                    "›"
                } else {
                    " "
                },
                if q.selected[i] { "x" } else { " " },
                option.label
            ),
            width,
            Style::default().fg(if q.selected[i] { ACCENT } else { Color::Reset }),
        ));
        if let Some(description) = &option.description {
            content.extend(lines(
                &format!("    {description}"),
                width,
                Style::default().fg(MUTED),
            ));
        }
    }
    content.push(Line::raw(""));
    content.push(Line::styled(
        if form.editing {
            "自由入力 · 編集中（Ctrl+Eで選択へ）"
        } else {
            "自由入力 · Ctrl+Eで編集"
        },
        Style::default().fg(if form.editing { ACCENT } else { MUTED }),
    ));
    let custom_start = content.len();
    let (custom, (cx, cy)) = wrap(&q.custom.text, width, q.custom.cursor);
    content.extend(custom.into_iter().map(Line::raw));
    if form.editing {
        focused_line = custom_start + cy as usize;
    }
    form.max_scroll = content.len().saturating_sub(rows[0].height as usize);
    if form.follow_focus {
        if focused_line < form.scroll {
            form.scroll = focused_line;
        } else if focused_line >= form.scroll + rows[0].height as usize {
            form.scroll = focused_line.saturating_sub(rows[0].height.saturating_sub(1) as usize);
        }
    }
    form.scroll = form.scroll.min(form.max_scroll);
    frame.render_widget(
        Paragraph::new(
            content
                .into_iter()
                .skip(form.scroll)
                .take(rows[0].height as usize)
                .collect::<Vec<_>>(),
        ),
        rows[0],
    );
    if form.editing
        && focused_line >= form.scroll
        && focused_line < form.scroll + rows[0].height as usize
    {
        frame.set_cursor_position((
            rows[0].x + cx.min(rows[0].width.saturating_sub(1)),
            rows[0].y + (focused_line - form.scroll) as u16,
        ));
    }
    frame.render_widget(
        Paragraph::new(vec![
            Line::raw("Space 選択 / ↑↓ 移動 / Tab 次 / Shift+Tab 前"),
            Line::raw("Ctrl+E 自由入力 / Ctrl+S 全回答を送信"),
            Line::styled(
                if app.notice.is_empty() {
                    "PgUp/Dn・Home/End 詳細 / Esc 中止".into()
                } else {
                    clean(&app.notice)
                },
                Style::default().fg(APPROVAL),
            ),
        ]),
        rows[1],
    );
}
fn sessions(frame: &mut Frame, app: &App, area: Rect) {
    let Overlay::Sessions { items, selected } = &app.overlay else {
        return;
    };
    let area = popup(area, 96, 26);
    frame.render_widget(Clear, area);
    let border = block(" DSH セッション · Enter 再開 / Esc 戻る ");
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(2)])
        .split(inner);
    let entries = items
        .iter()
        .map(|item| {
            ListItem::new(vec![
                Line::raw(clean(&format!("{} · {}", item.title, item.id))),
                Line::styled(clean(&item.cwd), Style::default().fg(MUTED)),
            ])
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default().with_selected((!entries.is_empty()).then_some(*selected));
    frame.render_stateful_widget(
        List::new(entries)
            .highlight_symbol("› ")
            .highlight_style(Style::default().fg(Color::Black).bg(ACCENT)),
        rows[0],
        &mut state,
    );
    frame.render_widget(
        Paragraph::new(vec![
            Line::raw(if items.is_empty() {
                "保存済みセッションはありません".into()
            } else {
                format!("{} 件 · ↑↓ 選択 / Home/End", items.len())
            }),
            Line::styled(clean(&app.notice), Style::default().fg(APPROVAL)),
        ]),
        rows[1],
    );
}
fn readonly(frame: &mut Frame, app: &mut App, area: Rect) {
    let Overlay::ReadOnly { title, content } = &app.overlay else {
        return;
    };
    let title = *title;
    let content = content.clone();
    let mut rows = vec![Line::raw("↑↓ / PgUp/Dn / Home/End 閲覧 · Esc 閉じる")];
    rows.extend(content.split('\n').map(|line| Line::raw(line.to_owned())));
    details(frame, app, popup(area, 112, 30), title, rows);
}
fn usage_counter(usage: &Value, field: &str, known: &str) -> String {
    let requests = usage["requests"].as_u64().unwrap_or(0);
    let known = usage[known].as_u64().unwrap_or(0);
    if known == 0 {
        return "未取得".into();
    }
    format!(
        "{}{}",
        usage[field].as_u64().unwrap_or(0),
        if known < requests || usage["request_count_unknown"] == true {
            "*"
        } else {
            ""
        }
    )
}
fn usage_line(usage: &Value) -> String {
    let cache = usage["cache_hit_rate"]
        .as_f64()
        .map(|p| {
            format!(
                "{p:.1}%{}",
                if usage["known_cache_requests"] != usage["requests"]
                    || usage["request_count_unknown"] == true
                {
                    "*"
                } else {
                    ""
                }
            )
        })
        .unwrap_or_else(|| "未取得".into());
    format!(
        "Token In:{} Out:{}  Cache:{}  Req:{}",
        usage_counter(usage, "input_tokens", "known_input_requests"),
        usage_counter(usage, "output_tokens", "known_output_requests"),
        cache,
        if usage["request_count_unknown"] == true {
            "?".into()
        } else {
            usage["requests"].as_u64().unwrap_or(0).to_string()
        }
    )
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
fn details(frame: &mut Frame, app: &mut App, area: Rect, title: &str, content: Vec<Line<'static>>) {
    frame.render_widget(Clear, area);
    let border = block(title).border_style(Style::default().fg(ACCENT));
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let wrapped = content
        .into_iter()
        .flat_map(|line| lines(&line.to_string(), inner.width.saturating_sub(1), line.style))
        .collect::<Vec<_>>();
    app.detail_max_scroll = wrapped.len().saturating_sub(inner.height as usize);
    app.detail_scroll = if app.detail_follow {
        app.detail_max_scroll
    } else {
        app.detail_scroll.min(app.detail_max_scroll)
    };
    frame.render_widget(
        Paragraph::new(
            wrapped
                .into_iter()
                .skip(app.detail_scroll)
                .take(inner.height as usize)
                .collect::<Vec<_>>(),
        ),
        inner,
    );
}
fn log_panel(frame: &mut Frame, app: &mut App, snapshot: &Value, area: Rect) {
    let area = popup(area, 96, 26);
    let mut content = Vec::new();
    for event in snapshot["events"].as_array().into_iter().flatten() {
        content.push(Line::styled(
            format!("{} / {}", text(&event["kind"]), text(&event["name"])),
            Style::default().fg(ACCENT),
        ));
        content.push(Line::raw(text(&event["content"])));
        content.push(Line::raw(""));
    }
    if content.is_empty() {
        content.push(Line::raw("実行ログはまだありません。"));
    }
    details(
        frame,
        app,
        area,
        " 実行ログ · ↑↓ / PgUp/Dn / Home/End / Esc ",
        content,
    );
}
fn diagnostics(frame: &mut Frame, app: &mut App, snapshot: &Value, area: Rect) {
    let mut content = Vec::new();
    for note in snapshot["diagnostics"].as_array().into_iter().flatten() {
        content.push(Line::raw(text(note)));
    }
    for provider in snapshot["providers"].as_array().into_iter().flatten() {
        for model in provider["models"].as_array().into_iter().flatten() {
            if let Some(reason) = model["unavailable"].as_str() {
                content.push(Line::styled(
                    format!("{} / {}", text(&provider["id"]), text(&model["id"])),
                    Style::default().fg(APPROVAL),
                ));
                content.push(Line::raw(clean(reason)));
                content.push(Line::raw(""));
            }
        }
    }
    if content.is_empty() {
        content.push(Line::raw("問題は報告されていません。"));
    }
    details(
        frame,
        app,
        popup(area, 96, 26),
        " 接続診断 · ↑↓ / PgUp/Dn / Esc ",
        content,
    );
}
fn status_panel(frame: &mut Frame, app: &mut App, snapshot: &Value, area: Rect) {
    let area = popup(area, 96, 24);
    frame.render_widget(Clear, area);
    let mut content = vec![
        Line::raw(format!("状態: {}", text(&snapshot["status"]))),
        Line::raw(format!(
            "モデル: {} / {}",
            text(&snapshot["provider"]),
            text(&snapshot["model"])
        )),
    ];
    content.push(Line::raw(format!(
        "モード: {}{} / パーミッション: {}",
        snapshot["controls"]["mode"]
            .as_str()
            .unwrap_or("未対応／未取得"),
        if snapshot["controls"]["planPending"] == true {
            "（切替待ち）"
        } else {
            ""
        },
        snapshot["controls"]["permission"]
            .as_str()
            .unwrap_or("未対応／未取得")
    )));
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
    let usage = &snapshot["usage"];
    content.push(Line::raw(""));
    content.extend(lines(
        &usage_line(usage),
        area.width.saturating_sub(2),
        Style::default().fg(ACCENT),
    ));
    content.push(Line::raw(format!(
        "キャッシュ集計対象: {} / {} リクエスト（読込 / 入力）",
        usage["known_cache_requests"].as_u64().unwrap_or(0),
        if usage["request_count_unknown"] == true {
            "?".into()
        } else {
            usage["requests"].as_u64().unwrap_or(0).to_string()
        }
    )));
    if let Some(last) = usage.get("last").filter(|v| !v.is_null()) {
        content.extend(lines(
            &format!(
                "直近: {} / {}",
                text(&last["provider"]),
                text(&last["model"])
            ),
            area.width.saturating_sub(2),
            Style::default(),
        ));
        content.push(Line::raw(format!(
            "直近応答時間: {}",
            last["elapsed_ms"]
                .as_u64()
                .map(|v| format!("{v} ms"))
                .unwrap_or_else(|| "未取得".into())
        )));
        content.push(Line::raw(format!(
            "直近 Cache Read:{} Write:{} Reasoning:{}",
            last["usage"]["cache_read_tokens"]
                .as_u64()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "未取得".into()),
            last["usage"]["cache_write_tokens"]
                .as_u64()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "未取得".into()),
            last["usage"]["reasoning_tokens"]
                .as_u64()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "未取得".into())
        )));
    }
    content.push(Line::styled(
        "* は既知分のみ。未取得は0ではありません。料金・残枠の推定は行いません。",
        Style::default().fg(MUTED),
    ));
    content.push(Line::raw(""));
    content.push(Line::styled(
        if snapshot["capabilities"]["sessionPersistence"] == true {
            "DSHセッションは保存されます。/sessionsで再開できます。"
        } else {
            "会話はメモリー内で保持。保存・再開は未対応です。"
        },
        Style::default().fg(MUTED),
    ));
    content.extend(lines(
        &text(&snapshot["error"]),
        area.width.saturating_sub(2),
        Style::default().fg(Color::Yellow),
    ));
    content.push(Line::raw(""));
    content.push(Line::raw("Esc / Enter で閉じる"));
    details(frame, app, area, " 状態 · ↑↓ / PgUp/Dn / Esc ", content);
}
fn new_chat(frame: &mut Frame, confirm: bool, snapshot: &Value, area: Rect) {
    let area = popup(area, 76, 10);
    frame.render_widget(Clear, area);
    let selected = Style::default()
        .fg(Color::Black)
        .bg(APPROVAL)
        .add_modifier(Modifier::BOLD);
    frame.render_widget(
        Paragraph::new(vec![
            Line::raw(if snapshot["capabilities"]["sessionPersistence"] == true {
                "新しいセッションを開始し、画面と入力履歴を初期化します。"
            } else {
                "現在の会話と入力履歴を消して、新しい会話を始めます。"
            }),
            Line::raw(if snapshot["capabilities"]["sessionPersistence"] == true {
                "現在のセッションは保存され、/sessionsで再開できます。"
            } else {
                "元の会話には戻れません。ファイルは変更しません。"
            }),
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
fn help(frame: &mut Frame, app: &mut App, area: Rect) {
    let area = popup(area, 96, 30);
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
    details(frame, app, area, " 操作方法 · ↑↓ / PgUp/Dn / Esc ", content);
}

fn controls_label(snapshot: &Value) -> String {
    let controls = &snapshot["controls"];
    if controls["mode"].is_null() && controls["permission"].is_null() {
        return String::new();
    }
    format!(
        " [{}{} · {}]",
        controls["mode"].as_str().unwrap_or("?"),
        if controls["planPending"] == true {
            "→待ち"
        } else {
            ""
        },
        controls["permission"].as_str().unwrap_or("?")
    )
}
fn permission_change(frame: &mut Frame, app: &mut App, area: Rect) {
    let Overlay::Permission {
        preset,
        description,
        confirm,
    } = &app.overlay
    else {
        return;
    };
    let (preset, description, confirm) = (preset.clone(), description.clone(), *confirm);
    let area = popup(area, 86, 14);
    frame.render_widget(Clear, area);
    let border = block(" パーミッション変更の確認 ").border_style(Style::default().fg(APPROVAL));
    let inner = border.inner(area);
    frame.render_widget(border, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(3)])
        .split(inner);
    let width = rows[0].width.saturating_sub(1);
    let mut content = lines(
        &format!("変更先: {}", clean(&preset)),
        width,
        Style::default(),
    );
    content.extend(lines(&description, width, Style::default()));
    content.extend(lines(
        "適用後のツール承認方法が変わります。内容を確認してください。",
        width,
        Style::default(),
    ));
    app.detail_max_scroll = content.len().saturating_sub(rows[0].height as usize);
    app.detail_scroll = app.detail_scroll.min(app.detail_max_scroll);
    let total = content.len();
    frame.render_widget(
        Paragraph::new(
            content
                .into_iter()
                .skip(app.detail_scroll)
                .take(rows[0].height as usize)
                .collect::<Vec<_>>(),
        ),
        rows[0],
    );
    if app.detail_max_scroll > 0 {
        let mut state = ScrollbarState::new(total)
            .position(app.detail_scroll)
            .viewport_content_length(rows[0].height as usize);
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight),
            rows[0],
            &mut state,
        );
    }
    let selected = Style::default()
        .fg(Color::Black)
        .bg(APPROVAL)
        .add_modifier(Modifier::BOLD);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(" 戻る ", if !confirm { selected } else { Style::default() }),
                Span::raw("    "),
                Span::styled(
                    " 設定を適用 ",
                    if confirm { selected } else { Style::default() },
                ),
            ]),
            Line::raw("Tab/←→ 選択 Enter確定 Esc戻る"),
            if app.notice.is_empty() {
                Line::raw("↑↓/PgUp/Dn 説明 Home/End")
            } else {
                Line::styled(clean(&app.notice), Style::default().fg(Color::Yellow))
            },
        ]),
        rows[1],
    );
}
