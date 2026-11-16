//! 切れ目の決まり（RQ-08 と NW-02）。

use std::ops::Range;

/// 履歴の 1 件の種類。
/// メッセージの中身は持たない。切れ目を決めるのに要る分だけを持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemKind {
    System,
    User,
    Assistant,
    /// ツール呼び出しの提案。中の呼び出しの id を持つ。
    ToolCalls {
        call_ids: Vec<String>,
    },
    /// ツールの結果。どの呼び出しへの答えかを持つ。
    ToolResult {
        call_id: String,
    },
    /// 前の圧縮で作った要約。
    Summary,
    /// プロバイダが返した圧縮結果。開けず、動かさない（RQ-02）。
    ProviderCompaction,
}

/// 履歴の 1 件。size は Capacity と同じ単位で数える。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub kind: ItemKind,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CutRequest<'a> {
    pub items: &'a [Item],
    /// 直近として残す量。resolve_threshold が返す retain を入れる。
    pub retain: u64,
    /// 最初の User をそのまま残すか。native-web では true。
    pub keep_first_user: bool,
}

/// 圧縮の対象。items の range の部分を、要約 1 つに置き換える。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cut {
    pub range: Range<usize>,
    /// 対象の大きさの合計。
    pub size: u64,
}

/// 圧縮の対象を選ぶ。安全に選べない時は None を返し、履歴は変えない。
///
/// 決まりは 5 つ。
/// 先頭の System は対象に入れない。keep_first_user が true なら、最初の User も入れない。
/// ProviderCompaction がある時は、対象はその後ろから始める。
/// 末尾から数えて retain に収まる分は、対象に入れない。
/// ToolCalls とその ToolResult は、切れ目の同じ側に置く。
/// 間に切れ目が来た時は、切れ目を新しい側へ動かして、組を対象に入れる。
/// 答えの返っていない ToolCalls は、対象に入れない。
/// そのせいで組が割れる時は、組ごと残す側に置く。
pub fn select_cut(request: &CutRequest<'_>) -> Option<Cut> {
    let items = request.items;
    let len = items.len();

    // 対象の始まりを決める。
    let mut start = 0;
    while start < len && items[start].kind == ItemKind::System {
        start += 1;
    }
    if let Some(last) = items
        .iter()
        .rposition(|item| item.kind == ItemKind::ProviderCompaction)
    {
        start = start.max(last + 1);
    }
    if request.keep_first_user {
        if let Some(first) = items.iter().position(|item| item.kind == ItemKind::User) {
            if first >= start {
                start = first + 1;
            }
        }
    }

    // 対象の終わりを決める。末尾から retain に収まる分を残す。
    let mut end = len;
    let mut kept: u64 = 0;
    while end > start && kept.saturating_add(items[end - 1].size) <= request.retain {
        kept += items[end - 1].size;
        end -= 1;
    }

    // 対象より前にある呼び出しへの答えは、対象に入れない。
    loop {
        let orphan = (start..end).find(|&index| match &items[index].kind {
            ItemKind::ToolResult { call_id } => !has_call(&items[start..index], call_id),
            _ => false,
        });
        match orphan {
            Some(index) => start = index + 1,
            None => break,
        }
    }

    // 切れ目で割れた組は、切れ目を新しい側へ動かして対象に入れる。
    loop {
        let mut next = end;
        for index in start..end {
            if let Pairing::Answered(found) = pairing(items, index) {
                if found >= next {
                    next = found + 1;
                }
            }
        }
        if next == end {
            break;
        }
        end = next;
    }

    // 答えの返っていない呼び出しは、残す側に置く。
    let unanswered =
        (start..end).find(|&index| matches!(pairing(items, index), Pairing::Unanswered));
    if let Some(first) = unanswered {
        end = first;
        // 残す側へ動かして割れた組は、組ごと残す側に置く。
        loop {
            let split = (start..end).find(|&index| match pairing(items, index) {
                Pairing::Answered(found) => found >= end,
                _ => false,
            });
            match split {
                Some(index) => end = index,
                None => break,
            }
        }
    }

    if start >= end {
        return None;
    }
    let size: u64 = items[start..end].iter().map(|item| item.size).sum();
    Some(Cut {
        range: start..end,
        size,
    })
}

/// ToolCalls 1 件について、答えがどこまで返っているか。
enum Pairing {
    /// ツール呼び出しではない。または、呼び出しが 1 つも入っていない。
    NotCalls,
    /// 全部の答えが返っている。値は、いちばん後ろの答えの位置。
    Answered(usize),
    /// 答えの返っていない呼び出しがある。
    Unanswered,
}

fn pairing(items: &[Item], index: usize) -> Pairing {
    let call_ids = match &items[index].kind {
        ItemKind::ToolCalls { call_ids } => call_ids,
        _ => return Pairing::NotCalls,
    };
    let mut last: Option<usize> = None;
    for call_id in call_ids {
        match result_index(items, index, call_id) {
            Some(found) => {
                last = Some(match last {
                    Some(current) if current > found => current,
                    _ => found,
                });
            }
            None => return Pairing::Unanswered,
        }
    }
    match last {
        Some(found) => Pairing::Answered(found),
        None => Pairing::NotCalls,
    }
}

/// after より後ろにある、call_id への答えの位置。
fn result_index(items: &[Item], after: usize, call_id: &str) -> Option<usize> {
    items
        .iter()
        .enumerate()
        .skip(after + 1)
        .find_map(|(index, item)| match &item.kind {
            ItemKind::ToolResult { call_id: id } if id.as_str() == call_id => Some(index),
            _ => None,
        })
}

/// items の中に、call_id を持つ ToolCalls があるか。
fn has_call(items: &[Item], call_id: &str) -> bool {
    items.iter().any(|item| match &item.kind {
        ItemKind::ToolCalls { call_ids } => call_ids.iter().any(|id| id.as_str() == call_id),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: ItemKind, size: u64) -> Item {
        Item { kind, size }
    }

    fn calls(ids: &[&str]) -> ItemKind {
        ItemKind::ToolCalls {
            call_ids: ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    fn result(id: &str) -> ItemKind {
        ItemKind::ToolResult {
            call_id: id.to_string(),
        }
    }

    #[test]
    fn cut_keeps_the_head_and_the_recent_tail() {
        let items = vec![
            item(ItemKind::System, 100),
            item(ItemKind::User, 50),
            item(ItemKind::Assistant, 200),
            item(ItemKind::User, 60),
            item(ItemKind::Assistant, 300),
            item(ItemKind::User, 40),
            item(ItemKind::Assistant, 80),
        ];
        let cut = select_cut(&CutRequest {
            items: &items,
            retain: 150,
            keep_first_user: true,
        })
        .unwrap();
        assert_eq!(cut.range, 2..5);
        assert_eq!(cut.size, 560);
    }

    #[test]
    fn cut_does_not_split_a_call_from_its_result() {
        let items = vec![
            item(ItemKind::User, 10),
            item(calls(&["a"]), 20),
            item(result("a"), 500),
            item(ItemKind::Assistant, 30),
            item(ItemKind::User, 10),
            item(ItemKind::Assistant, 10),
        ];
        let cut = select_cut(&CutRequest {
            items: &items,
            retain: 560,
            keep_first_user: true,
        })
        .unwrap();
        // retain だけで決めると、切れ目は呼び出しと結果の間に来る。結果も対象に入れる。
        assert_eq!(cut.range, 1..3);
        assert_eq!(cut.size, 520);
    }

    #[test]
    fn cut_leaves_an_unanswered_call_in_the_tail() {
        let items = vec![
            item(ItemKind::User, 10),
            item(ItemKind::Assistant, 100),
            item(calls(&["b"]), 20),
        ];
        let cut = select_cut(&CutRequest {
            items: &items,
            retain: 0,
            keep_first_user: true,
        })
        .unwrap();
        assert_eq!(cut.range, 1..2);
        assert_eq!(cut.size, 100);
    }

    #[test]
    fn cut_gives_up_when_pairs_cannot_stay_together() {
        let items = vec![
            item(ItemKind::User, 1),
            item(calls(&["a"]), 1),
            item(calls(&["b"]), 1),
            item(result("a"), 1),
        ];
        let cut = select_cut(&CutRequest {
            items: &items,
            retain: 0,
            keep_first_user: true,
        });
        assert_eq!(cut, None);
    }

    #[test]
    fn cut_starts_after_a_provider_compaction() {
        let items = vec![
            item(ItemKind::ProviderCompaction, 50),
            item(ItemKind::User, 10),
            item(ItemKind::Assistant, 100),
            item(ItemKind::User, 10),
        ];
        let cut = select_cut(&CutRequest {
            items: &items,
            retain: 10,
            keep_first_user: false,
        })
        .unwrap();
        assert_eq!(cut.range, 1..3);
        assert_eq!(cut.size, 110);
    }

    #[test]
    fn cut_returns_none_when_only_the_head_exists() {
        let items = vec![item(ItemKind::System, 100), item(ItemKind::User, 50)];
        let cut = select_cut(&CutRequest {
            items: &items,
            retain: 0,
            keep_first_user: true,
        });
        assert_eq!(cut, None);
    }
}
