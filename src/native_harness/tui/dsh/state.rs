//! Presentation fold for the DSH Remote journal. No decisions or tools execute here.
use crate::native_harness::usage::{Usage, UsageStats};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::Path,
};

const MAX_RECORDS: usize = 1500;
const MAX_TEXT: usize = 128 * 1024;
const MAX_PENDING: usize = 64;

pub(super) struct View {
    pub session_id: String,
    pub client_id: String,
    pub value: Value,
    records: BTreeMap<u64, Value>,
    pending: VecDeque<Value>,
    tools: HashMap<String, Value>,
    catalogs: HashMap<String, Vec<String>>,
    child_tools: HashMap<String, HashMap<String, Value>>,
    child_events: VecDeque<Value>,
    child_sequences: HashMap<String, u64>,
    unowned_request: bool,
    stream: Option<ActiveStream>,
    stream_revision: u64,
    projections: Value,
    projection_seq: HashMap<String, u64>,
    cursor: Option<u64>,
    truncated: bool,
    history_partial: bool,
    base_status: String,
}

struct ActiveStream {
    id: String,
    revision: u64,
    chunks: BTreeMap<u64, Value>,
}

impl View {
    pub(super) fn new(workspace: &Path, profile: &str, catalog: Value) -> Self {
        Self {
            session_id: String::new(),
            client_id: String::new(),
            value: json!({"backend":"dsh", "engine":"RDSH TUI · DSH runtime",
                "capabilities":{"sessionPersistence":true},"connected":false,
                "workspace":workspace.to_string_lossy(),"profile":profile,
                "provider":catalog["default"]["provider"],"model":catalog["default"]["model"],
                "providers":catalog["groups"].as_array().cloned().unwrap_or_default(),
                "messages":[],"events":[],"pending":null,"error":null,"diagnostics":[],
                "status":"idle","controls":{},"usage":UsageStats::default().snapshot()}),
            records: BTreeMap::new(),
            pending: VecDeque::new(),
            tools: HashMap::new(),
            catalogs: HashMap::new(),
            child_tools: HashMap::new(),
            child_events: VecDeque::new(),
            child_sequences: HashMap::new(),
            unowned_request: false,
            stream: None,
            stream_revision: 0,
            projections: json!({}),
            projection_seq: HashMap::new(),
            cursor: None,
            truncated: false,
            history_partial: false,
            base_status: "idle".into(),
        }
    }
    pub(super) fn set_session(&mut self, id: &str) {
        self.session_id = id.into();
        self.value["sessionId"] = json!(id);
        self.value["loaded"] = json!(false);
        self.records.clear();
        self.pending.clear();
        self.tools.clear();
        self.catalogs.clear();
        self.child_tools.clear();
        self.child_events.clear();
        self.child_sequences.clear();
        self.unowned_request = false;
        self.value["subagentUsage"] = json!({});
        self.stream = None;
        self.stream_revision = 0;
        self.projections = json!({});
        self.projection_seq.clear();
        self.cursor = None;
        self.truncated = false;
        self.history_partial = false;
        self.base_status = "idle".into();
        self.value["messages"] = json!([]);
        self.value["events"] = json!([]);
        self.value["pending"] = Value::Null;
        self.value["error"] = Value::Null;
        self.value["subagents"] = json!(self.owned_sessions());
        self.value["diagnostics"] = json!([]);
        self.value["status"] = json!("loading");
        self.value["usage"] = UsageStats::default().snapshot();
    }
    pub(super) fn snapshot(&self) -> Value {
        self.value.clone()
    }
    pub(super) fn connected(&mut self) {
        self.value["connected"] = json!(true);
        if self.value["error"].as_str() == Some("DSH接続が切れました。再接続しています")
        {
            self.value["error"] = Value::Null;
        }
    }
    pub(super) fn disconnected(&mut self) {
        self.value["connected"] = json!(false);
        self.value["loaded"] = json!(false);
        self.client_id.clear();
        self.pending.clear();
        self.value["pending"] = Value::Null;
        self.value["error"] = json!("DSH接続が切れました。再接続しています");
        self.value["status"] = json!("error");
    }
    pub(super) fn fail(&mut self, message: &str) {
        self.value["error"] = json!(bounded(message));
        self.base_status = "error".into();
        self.sync_pending();
    }
    pub(super) fn pending_event(&self, id: &str) -> Option<Value> {
        let mut event = self
            .pending
            .front()
            .filter(|v| v["eventId"].as_str() == Some(id))?
            .clone();
        let normalized = &self.value["pending"];
        event["continued"] = normalized["continued"].clone();
        event["callId"] = normalized["callId"].clone();
        event["detailsUnavailable"] = normalized["detailsUnavailable"].clone();
        event["questions"] = normalized["questions"].clone();
        Some(event)
    }
    pub(super) fn cancel_event(&mut self, id: &str) {
        self.pending.retain(|v| v["eventId"].as_str() != Some(id));
        self.sync_pending();
    }
    pub(super) fn waterfall(&mut self, event: &Value) -> bool {
        let agent = event["agentId"].as_str().unwrap_or("");
        if self.session_id.is_empty()
            || (agent != self.session_id && !self.owned_sessions().iter().any(|id| id == agent))
        {
            self.unowned_request = true;
            return false;
        }
        if !matches!(
            event["event"].as_str(),
            Some("approval/request" | "user-questions/request")
        ) || event["eventId"].as_str().is_none()
        {
            return false;
        }
        let id = event["eventId"].as_str().unwrap();
        if self
            .pending
            .iter()
            .any(|v| v["eventId"].as_str() == Some(id))
        {
            return true;
        }
        if self.pending.len() >= MAX_PENDING {
            self.fail("DSHの未回答要求が上限に達しました");
            return false;
        }
        // A live waterfall replaces a projection-only question for the same call.
        if let Some(call) = event["request"]["wait"]["callId"].as_str() {
            self.pending.retain(|v| {
                !(v["projection"] == true
                    && v["request"]["wait"]["callId"] == call
                    && v["agentId"] == event["agentId"])
            });
        }
        self.pending.push_back(event.clone());
        self.sync_pending();
        true
    }
    pub(super) fn apply_follow(&mut self, frame: &Value) {
        match frame["type"].as_str() {
            Some("snapshot") => {
                if let Some(id) = frame["header"]["id"].as_str() {
                    if id != self.session_id {
                        return;
                    }
                }
                self.records.clear();
                self.tools.clear();
                self.stream = None;
                self.cursor = frame["cursor"].as_u64();
                self.history_partial = frame["hasMore"] == true;
                self.truncated = false;
                self.stream_revision = frame["assistantStream"]["revision"].as_u64().unwrap_or(0);
                self.add_records(&frame["records"]);
                self.projections = frame["projections"]["values"].clone();
                let catalog = self.projections["subagentCatalog"].clone();
                let root_id = self.session_id.clone();
                self.remember_catalog(&root_id, &catalog);
                let seq = frame["projections"]["asOfSeq"].as_u64().unwrap_or(0);
                self.projection_seq.clear();
                if let Some(values) = self.projections.as_object() {
                    for key in values.keys() {
                        self.projection_seq.insert(key.clone(), seq);
                    }
                }
                if let Some(active) = frame["assistantStream"]["activeAttempt"].as_object() {
                    let mut chunks = BTreeMap::new();
                    if let Some(stream) = active.get("stream").and_then(Value::as_array) {
                        for (i, chunk) in expand_stream(stream).into_iter().enumerate() {
                            chunks.insert(i as u64, chunk);
                        }
                    }
                    self.stream = Some(ActiveStream {
                        id: active
                            .get("attemptId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        revision: frame["assistantStream"]["revision"].as_u64().unwrap_or(0),
                        chunks,
                    });
                }
                self.value["loaded"] = json!(true);
                self.rebuild();
                self.restore_questions();
                self.sync_pending();
            }
            Some("event") => {
                let e = &frame["event"];
                let Some(seq) = e["seq"].as_u64() else {
                    return;
                };
                if self.cursor.is_some_and(|cursor| seq <= cursor) {
                    return;
                }
                self.cursor = Some(seq);
                if let Some(event) = display_event(e) {
                    self.records.insert(seq, event);
                }
                self.trim_records();
                if matches!(
                    e["type"].as_str(),
                    Some("assistant/message" | "assistant/attempt")
                ) {
                    self.stream = None;
                }
                self.rebuild();
                self.sync_pending();
            }
            Some("assistant-stream") => {
                self.apply_stream(&frame["frame"]);
                self.rebuild();
                self.sync_pending();
            }
            _ => {}
        }
    }
    /// Adds older records without replacing a newer stream or projection cut.
    pub(super) fn prepend_records(&mut self, records: &Value) {
        self.add_records(records);
        self.rebuild();
        self.sync_pending();
    }
    pub(super) fn history_complete(&mut self) {
        self.history_partial = false;
        self.rebuild();
    }
    fn add_records(&mut self, records: &Value) {
        for record in records.as_array().into_iter().flatten() {
            let e = &record["event"];
            if let (Some(seq), Some(event)) = (e["seq"].as_u64(), display_event(e)) {
                self.records.entry(seq).or_insert(event);
            }
        }
        self.trim_records();
    }
    fn trim_records(&mut self) {
        while self.records.len() > MAX_RECORDS {
            self.records.pop_first();
            self.truncated = true;
        }
    }
    pub(super) fn apply_control(&mut self, frame: &Value) {
        // The authenticated Host supplies catalogs for all sessions. Ownership is
        // derived only along a catalog chain rooted at this UI's own session.
        if frame["type"] == "baseline" {
            if let Some(projections) = frame["value"]["projections"].as_object() {
                for (id, p) in projections {
                    self.remember_catalog(id, &p["values"]["subagentCatalog"]);
                }
            }
        } else if frame["type"] == "projection" && frame["key"] == "subagentCatalog" {
            if let Some(id) = frame["sessionId"].as_str() {
                self.remember_catalog(id, &frame["value"]);
            }
        }
        if frame["type"] == "projection" && frame["key"] == "tokenUsage" {
            if let Some(id) = frame["sessionId"].as_str() {
                if id != self.session_id && self.owned_sessions().iter().any(|owned| owned == id) {
                    if !self.value["subagentUsage"].is_object() {
                        self.value["subagentUsage"] = json!({});
                    }
                    self.value["subagentUsage"][id] = frame["value"].clone();
                }
            }
        }
        if frame["type"] == "baseline" {
            for agent in self.owned_sessions() {
                self.restore_questions_for(
                    &agent,
                    &frame["value"]["projections"][&agent]["values"]["userQuestions"],
                );
            }
        } else if frame["type"] == "projection" && frame["key"] == "userQuestions" {
            if let Some(agent) = frame["sessionId"].as_str() {
                if agent != self.session_id && self.owned_sessions().iter().any(|id| id == agent) {
                    self.restore_questions_for(agent, &frame["value"]);
                    self.sync_pending();
                    return;
                }
            }
        }
        match frame["type"].as_str() {
            Some("baseline") => {
                let p = &frame["value"]["projections"][&self.session_id];
                let Some(values) = p["values"].as_object() else {
                    return;
                };
                let seq = p["asOfSeq"].as_u64().unwrap_or(0);
                for (key, value) in values {
                    self.set_projection(key, value, seq);
                }
            }
            Some("projection") if frame["sessionId"].as_str() == Some(self.session_id.as_str()) => {
                let Some(key) = frame["key"].as_str() else {
                    return;
                };
                self.set_projection(key, &frame["value"], frame["seq"].as_u64().unwrap_or(0));
            }
            _ => return,
        }
        self.rebuild();
        self.restore_questions();
        self.sync_pending();
    }
    fn remember_catalog(&mut self, id: &str, catalog: &Value) {
        let Some(rows) = catalog.as_array() else {
            return;
        };
        if self.catalogs.len() >= 2048 && !self.catalogs.contains_key(id) {
            return;
        }
        self.catalogs.insert(
            id.into(),
            rows.iter()
                .take(512)
                .filter_map(|v| v["id"].as_str().map(str::to_owned))
                .collect(),
        );
    }
    pub(super) fn owned_sessions(&self) -> Vec<String> {
        let mut seen = HashSet::from([self.session_id.clone()]);
        let mut queue = VecDeque::from([self.session_id.clone()]);
        let mut result = Vec::new();
        while let Some(parent) = queue.pop_front() {
            for id in self.catalogs.get(&parent).into_iter().flatten() {
                if result.len() >= 2048 {
                    return result;
                }
                if seen.insert(id.clone()) {
                    result.push(id.clone());
                    queue.push_back(id.clone());
                }
            }
        }
        result
    }
    pub(super) fn apply_child_follow(&mut self, agent: &str, frame: &Value) {
        if !self.owned_sessions().iter().any(|owned| owned == agent) {
            return;
        }
        let mut events = Vec::new();
        match frame["type"].as_str() {
            Some("snapshot") => {
                if frame["header"]["id"].as_str() != Some(agent) {
                    return;
                }
                self.child_tools.insert(agent.into(), HashMap::new());
                self.child_sequences
                    .insert(agent.into(), frame["cursor"].as_u64().unwrap_or(0));
                let catalog = &frame["projections"]["values"]["subagentCatalog"];
                self.remember_catalog(agent, catalog);
                self.restore_questions_for(agent, &frame["projections"]["values"]["userQuestions"]);
                if !self.value["subagentUsage"].is_object() {
                    self.value["subagentUsage"] = json!({});
                }
                self.value["subagentUsage"][agent] =
                    frame["projections"]["values"]["tokenUsage"].clone();
                events.extend(
                    frame["records"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|v| v["event"].clone()),
                );
            }
            Some("event") => {
                let e = &frame["event"];
                let Some(seq) = e["seq"].as_u64() else {
                    return;
                };
                if self
                    .child_sequences
                    .get(agent)
                    .is_some_and(|old| seq <= *old)
                {
                    return;
                }
                self.child_sequences.insert(agent.into(), seq);
                events.push(e.clone());
            }
            _ => return,
        }
        let tools = self.child_tools.entry(agent.into()).or_default();
        for e in events {
            let data = &e["data"];
            match e["type"].as_str() {
                Some("tool/call") => {
                    if let Some(id) = data["callId"].as_str() {
                        let args = data["arguments"]
                            .as_str()
                            .filter(|s| s.len() <= MAX_TEXT)
                            .and_then(|s| serde_json::from_str::<Value>(s).ok());
                        if tools.len() < 512 || tools.contains_key(id) {
                            tools.insert(id.into(),json!({"name":data["name"],"arguments":args,"complete":args.is_some()}));
                        }
                    }
                    self.child_events.push_back(json!({"kind":"tool","name":format!("{agent} · {}",data["name"].as_str().unwrap_or("tool")),"content":bounded(data["arguments"].as_str().unwrap_or(""))}));
                }
                Some("assistant/message") => remember_tools(&data["message"]["content"], tools),
                _ => {}
            }
        }
        while self.child_events.len() > 128 {
            self.child_events.pop_front();
        }
        self.rebuild();
        self.sync_pending();
    }
    fn set_projection(&mut self, key: &str, value: &Value, seq: u64) {
        if self.projection_seq.get(key).is_some_and(|old| seq < *old) {
            return;
        }
        if !self.projections.is_object() {
            self.projections = json!({});
        }
        self.projections[key] = value.clone();
        self.projection_seq.insert(key.into(), seq);
    }
    fn apply_stream(&mut self, frame: &Value) {
        let Some(id) = frame["attemptId"].as_str() else {
            return;
        };
        let revision = frame["revision"].as_u64().unwrap_or(0);
        if revision <= self.stream_revision {
            return;
        }
        self.stream_revision = revision;
        match frame["type"].as_str() {
            Some("start") => {
                if self.stream.as_ref().is_some_and(|s| revision <= s.revision) {
                    return;
                }
                self.stream = Some(ActiveStream {
                    id: id.into(),
                    revision,
                    chunks: BTreeMap::new(),
                });
                self.base_status = "running".into();
            }
            Some("chunk") => {
                if let Some(s) = &mut self.stream {
                    if s.id != id || revision < s.revision {
                        return;
                    }
                    if let Some(index) = frame["index"].as_u64() {
                        if s.chunks.len() < 16384 {
                            s.chunks
                                .entry(index)
                                .or_insert_with(|| frame["chunk"].clone());
                        }
                        s.revision = revision;
                    }
                }
            }
            Some("end")
                if self
                    .stream
                    .as_ref()
                    .is_some_and(|s| s.id == id && revision >= s.revision) =>
            {
                // The committed event normally precedes this frame; an abandoned attempt has no row.
                if frame["outcome"]["kind"] == "abandoned"
                    || frame["outcome"]["seq"]
                        .as_u64()
                        .is_some_and(|n| self.records.contains_key(&n))
                {
                    self.stream = None;
                }
            }
            _ => {}
        }
    }
    fn rebuild(&mut self) {
        let mut messages: Vec<(u64, Value)> = Vec::new();
        let mut events = Vec::new();
        let mut usage = UsageStats::default();
        let mut after_projection = UsageStats::default();
        let projection_cut = self.projection_seq.get("tokenUsage").copied();
        let mut tools = HashMap::new();
        let mut status = "idle";
        let mut error = None;
        for (seq, e) in &self.records {
            let data = &e["data"];
            let kind = e["type"].as_str().unwrap_or("");
            match kind {
                "turn/start" => {
                    status = "running";
                    error = None;
                }
                "turn/end" => {
                    status = if data["reason"]["kind"] == "error" {
                        "error"
                    } else {
                        "idle"
                    };
                    if status == "error" {
                        error = Some(
                            data["reason"]["error"]["message"]
                                .as_str()
                                .unwrap_or("DSHのモデル実行に失敗しました")
                                .to_owned(),
                        );
                    }
                }
                "request/context" | "model/selection" => {
                    if data["provider"].is_string() {
                        self.value["provider"] = data["provider"].clone();
                    }
                    if data["model"].is_string() {
                        self.value["model"] = data["model"].clone();
                    }
                }
                "user/message" => {
                    apply_surface(&mut messages, e);
                    messages.push((
                        *seq,
                        json!({"role":"user","content":content(&data["content"])}),
                    ));
                }
                "assistant/message" => {
                    apply_surface(&mut messages, e);
                    let message = &data["message"];
                    if let Some(provider) = message["source"]["provider"].as_str() {
                        self.value["provider"] = json!(provider);
                    }
                    if let Some(model) = message["source"]["model"].as_str() {
                        self.value["model"] = json!(model);
                    }
                    remember_tools(&message["content"], &mut tools);
                    let text = content(&message["content"]);
                    if !text.is_empty() {
                        messages.push((*seq, json!({"role":"assistant","content":text})));
                    }
                    usage.start(
                        self.value["provider"].as_str().unwrap_or(""),
                        self.value["model"].as_str().unwrap_or(""),
                    );
                    let measured = parse_usage(&data["usage"]);
                    usage.finish(&measured, 0);
                    if projection_cut.is_some_and(|cut| *seq > cut) {
                        after_projection.start("", "");
                        after_projection.finish(&measured, 0);
                    }
                }
                "assistant/attempt" => {
                    usage.start(
                        self.value["provider"].as_str().unwrap_or(""),
                        self.value["model"].as_str().unwrap_or(""),
                    );
                    usage.finish(&Usage::default(), 0);
                }
                "tool/call" => {
                    if let Some(id) = data["callId"].as_str() {
                        let args = data["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok());
                        tools.insert(
                            id.into(),
                            json!({"name":data["name"],"arguments":args,"complete":args.is_some()}),
                        );
                    }
                    events.push(json!({"kind":"tool","name":data["name"],"content":bounded(data["arguments"].as_str().unwrap_or(""))}));
                }
                "tool/result" => {
                    let message = &data["message"];
                    let text = content(&message["content"]);
                    messages.push((*seq, json!({"role":"tool","content":text})));
                    events.push(json!({"kind":if message["isError"]==true {"error"}else{"tool"},"name":"tool/result","content":content(&message["content"])}));
                }
                _ => {}
            }
        }
        self.tools = tools;
        if let Some(s) = &self.stream {
            let mut text = String::new();
            let mut stream_tools: HashMap<String, (String, String)> = HashMap::new();
            for chunk in s.chunks.values() {
                match chunk["type"].as_str() {
                    Some("text-delta") => {
                        append_bounded(&mut text, chunk["text"].as_str().unwrap_or(""))
                    }
                    Some("block-end") => {
                        remember_tools(&json!([chunk["block"]]), &mut self.tools);
                    }
                    Some("tool-call-delta") => {
                        if let Some(id) = chunk["id"].as_str() {
                            let row = stream_tools.entry(id.into()).or_default();
                            if let Some(name) = chunk["name"].as_str() {
                                row.0 = name.into();
                            }
                            append_bounded(
                                &mut row.1,
                                chunk["argumentsDelta"].as_str().unwrap_or(""),
                            );
                        }
                    }
                    _ => {}
                }
            }
            for (id, (name, args)) in stream_tools {
                let parsed = serde_json::from_str::<Value>(&args).ok();
                self.tools.insert(
                    id,
                    json!({"name":name,"arguments":parsed,"complete":parsed.is_some()}),
                );
            }
            if !text.is_empty() {
                messages.push((u64::MAX, json!({"role":"assistant","content":text})));
            }
            status = "running";
        }
        let next = &self.projections["modelSelection"]["next"];
        let selection = if next.is_object() {
            next
        } else {
            &self.projections["modelSelection"]["lastUsed"]
        };
        if selection["provider"].is_string() {
            self.value["provider"] = selection["provider"].clone();
        }
        if selection["model"].is_string() {
            self.value["model"] = selection["model"].clone();
        }
        let plan = &self.projections["plan"];
        self.value["controls"] = json!({
            "mode":plan["active"].as_bool().map(|active|if active {"plan"}else{"normal"}),
            "planPending":plan["pending"].as_bool(),
            "permission":self.projections["permissions"]["currentValue"].as_str()
        });
        self.value["messages"] = json!(messages.into_iter().map(|(_, m)| m).collect::<Vec<_>>());
        events.extend(self.child_events.iter().cloned());
        self.value["events"] = json!(events);
        let mut counts = usage.snapshot();
        counts["scope"] = json!("session");
        counts["request_count_unknown"] = json!(self.history_partial || self.truncated);
        counts["observed_requests"] = counts["requests"].clone();
        // Host totals already fold the entire durable log. Never add them to observed usage again.
        let p = &self.projections["tokenUsage"];
        let input = p["uncachedInputTokens"]
            .as_u64()
            .and_then(|n| n.checked_add(p["cacheReadTokens"].as_u64()?))
            .and_then(|n| n.checked_add(p["cacheWriteTokens"].as_u64()?));
        if let Some(input) = input {
            counts["input_tokens"] = json!(input.saturating_add(after_projection.input_tokens));
            counts["output_tokens"] = p["outputTokens"]
                .as_u64()
                .map(|n| json!(n.saturating_add(after_projection.output_tokens)))
                .unwrap_or(Value::Null);
            counts["cache_read_tokens"] = p["cacheReadTokens"]
                .as_u64()
                .map(|n| json!(n.saturating_add(after_projection.cache_read_tokens)))
                .unwrap_or(Value::Null);
            counts["cache_write_tokens"] = p["cacheWriteTokens"]
                .as_u64()
                .map(|n| json!(n.saturating_add(after_projection.cache_write_tokens)))
                .unwrap_or(Value::Null);
            counts["host_totals"] = p.clone();
            // Cache coverage is only known where the adapter supplied the optional buckets.
            // Use those observed, complete requests as the denominator, not unknown zeros.
        }
        self.value["usage"] = counts;
        self.base_status = status.into();
        if let Some(error) = error {
            self.value["error"] = json!(bounded(&error));
        } else if status != "error" {
            self.value["error"] = Value::Null;
        }
        self.value["subagents"] = json!(self.owned_sessions());
        self.value["diagnostics"] = json!([
            format!(
                "DSHプロファイル: {} · 既存のツール・プラグイン・承認ポリシーを使用",
                self.value["profile"].as_str().unwrap_or("")
            ),
            "Token総計はDSHの永続セッション集計。キャッシュ率は内訳が判明した要求のみで計算。"
                .to_owned(),
            if self.truncated {
                "表示履歴は最新1500イベントまで。元の永続セッションは保持されます。".to_owned()
            } else if self.history_partial {
                "過去の履歴を読み込み中。要求件数・キャッシュ率は表示済み履歴の範囲です。"
                    .to_owned()
            } else {
                "永続セッション履歴を表示しています。".to_owned()
            },
        ]);
        if let Some(notes) = self.value["diagnostics"].as_array_mut() {
            notes.push(json!("子セッションのToken使用量は別集計です。承認・質問はHostカタログで所有を確認したセッションだけ表示します。"));
            if self.unowned_request {
                notes.push(json!(
                    "所有関係を確認できない別セッションの要求は引き受けませんでした。"
                ));
            }
        }
    }
    fn restore_questions(&mut self) {
        let agent = self.session_id.clone();
        let questions = self.projections["userQuestions"].clone();
        self.restore_questions_for(&agent, &questions);
    }
    fn restore_questions_for(&mut self, agent: &str, questions: &Value) {
        let Some(active) = questions["active"].as_array() else {
            return;
        };
        self.pending.retain(|e| {
            e["projection"] != true
                || e["agentId"] != agent
                || active
                    .iter()
                    .any(|q| q["callId"] == e["request"]["wait"]["callId"])
        });
        for q in active {
            let Some(id) = q["callId"].as_str() else {
                continue;
            };
            if self
                .pending
                .iter()
                .any(|e| e["agentId"] == agent && e["request"]["wait"]["callId"] == id)
            {
                continue;
            }
            if self.pending.len() >= MAX_PENDING {
                break;
            }
            let event_id = if agent == self.session_id {
                format!("continued:{id}")
            } else {
                format!("continued:{agent}:{id}")
            };
            self.pending.push_back(json!({"eventId":event_id,"event":"user-questions/request","agentId":agent,"projection":true,
                "request":{"questions":q["questions"],"wait":{"callId":id},"state":q["state"]}}));
        }
    }
    fn sync_pending(&mut self) {
        let pending=self.pending.front().map(|e|{
            let request=&e["request"]; let id=&e["eventId"];
            if e["event"]=="user-questions/request" {
                json!({"id":id,"kind":"questions","tool":"user_questions","questions":request["questions"],
                    "arguments":{"questions":request["questions"]},"reason":"DSHからの質問です。回答を選択して送信してください。",
                    "agentId":e["agentId"],"wait":request["wait"],"continued":e["projection"]==true,"callId":request["wait"]["callId"]})
            }else{
                let tool=request["callId"].as_str().and_then(|id| {
                    if e["agentId"]==self.session_id {self.tools.get(id)} else {e["agentId"].as_str().and_then(|agent|self.child_tools.get(agent)).and_then(|tools|tools.get(id))}
                });
                let known=tool.is_some_and(|t|t["complete"]==true && t["name"]==request["toolName"]);
                json!({"id":id,"tool":request["toolName"],"arguments":if known {tool.unwrap()["arguments"].clone()} else {json!({"unavailable":"ツール引数がまだ届いていません","callId":request["callId"]})},
                    "reason":request["displayReason"].as_str().or_else(||request["reason"].as_str()).unwrap_or("DSHがこの操作の承認を要求しています。"),"detailsUnavailable":!known,"agentId":e["agentId"]})
            }
        }).unwrap_or(Value::Null);
        self.value["pending"] = pending;
        self.value["status"] = if !self.value["pending"].is_null() {
            json!("approval")
        } else {
            json!(self.base_status)
        };
    }
}

fn parse_usage(u: &Value) -> Usage {
    Usage {
        input_tokens: u["inputTokens"]
            .as_u64()
            .and_then(|n| n.checked_add(u["cacheReadTokens"].as_u64()?))
            .and_then(|n| n.checked_add(u["cacheWriteTokens"].as_u64()?)),
        output_tokens: u["outputTokens"].as_u64(),
        cache_read_tokens: u["cacheReadTokens"].as_u64(),
        cache_write_tokens: u["cacheWriteTokens"].as_u64(),
        reasoning_tokens: u["reasoningTokens"].as_u64(),
    }
}
fn remember_tools(blocks: &Value, tools: &mut HashMap<String, Value>) {
    for b in blocks.as_array().into_iter().flatten() {
        if b["type"] == "tool-call" {
            if let Some(id) = b["id"].as_str() {
                let args = b["arguments"]
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok());
                tools.insert(
                    id.into(),
                    json!({"name":b["name"],"arguments":args,"complete":args.is_some()}),
                );
            }
        }
    }
}
fn apply_surface(messages: &mut Vec<(u64, Value)>, e: &Value) {
    let op = &e["surfaceOp"];
    if op["op"] == "replace" {
        if let (Some(start), Some(end)) = (op["startSeq"].as_u64(), op["endSeq"].as_u64()) {
            messages.retain(|(seq, _)| *seq < start || *seq > end);
        }
    }
}
fn content(blocks: &Value) -> String {
    if let Some(s) = blocks.as_str() {
        return bounded(s);
    }
    let mut output = String::new();
    for b in blocks.as_array().into_iter().flatten() {
        let text = match b["type"].as_str() {
            Some("text") => b["text"].as_str().map(str::to_owned),
            Some("image") => Some("[画像]".into()),
            Some("file") => Some(format!(
                "[ファイル: {}]",
                b["name"].as_str().unwrap_or("添付")
            )),
            _ => None,
        };
        if let Some(text) = text {
            if !output.is_empty() {
                append_bounded(&mut output, "\n");
            }
            append_bounded(&mut output, &text);
        }
    }
    output
}
fn append_bounded(target: &mut String, text: &str) {
    let available = MAX_TEXT.saturating_sub(target.len());
    if available == 0 {
        return;
    }
    let mut cut = text.len().min(available);
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    target.push_str(&text[..cut]);
}
fn bounded(text: &str) -> String {
    let mut result = String::new();
    append_bounded(&mut result, text);
    if result.len() < text.len() {
        result.push_str("\n[表示を省略]");
    }
    result
}

fn expand_stream(records: &[Value]) -> Vec<Value> {
    let mut chunks = Vec::new();
    for record in records {
        match record["type"].as_str() {
            Some("text-chunks") | Some("reasoning-chunks") => {
                let kind = if record["type"] == "text-chunks" {
                    "text-delta"
                } else {
                    "reasoning-delta"
                };
                for text in record["texts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(16384usize.saturating_sub(chunks.len()))
                {
                    chunks.push(json!({"type":kind,"index":record["index"],"text":text}));
                }
            }
            Some("tool-call-chunks") => {
                for arg in record["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(16384usize.saturating_sub(chunks.len()))
                {
                    chunks.push(json!({"type":"tool-call-delta","index":record["index"],"id":record["id"],"name":record["name"],"argumentsDelta":arg}));
                }
            }
            Some("chunk") if chunks.len() < 16384 => chunks.push(record["chunk"].clone()),
            _ => {}
        }
    }
    chunks
}
// Keep only the surface and accounting fields used by this presentation fold.
// Opaque provider replay state and system prompt snapshots never need a UI copy.
fn display_event(event: &Value) -> Option<Value> {
    let kind = event["type"].as_str()?;
    if !matches!(
        kind,
        "turn/start"
            | "turn/end"
            | "request/context"
            | "model/selection"
            | "user/message"
            | "assistant/message"
            | "assistant/attempt"
            | "tool/call"
            | "tool/result"
    ) {
        return None;
    }
    let mut result = event.clone();
    match kind {
        "assistant/attempt" => result["data"] = json!({}),
        "assistant/message" => {
            let d = &event["data"];
            result["data"] = json!({"message":{"content":display_blocks(&d["message"]["content"]),"source":{"provider":d["message"]["source"]["provider"],"model":d["message"]["source"]["model"]}},"usage":d["usage"]});
        }
        "user/message" => {
            result["data"] = json!({"content":display_blocks(&event["data"]["content"])})
        }
        "tool/result" => {
            result["data"] = json!({"message":{"content":display_blocks(&event["data"]["message"]["content"]),"isError":event["data"]["message"]["isError"]}})
        }
        "tool/call" => {
            result["data"] = json!({"callId":event["data"]["callId"],"name":event["data"]["name"],"arguments":bounded(event["data"]["arguments"].as_str().unwrap_or(""))})
        }
        _ => {}
    }
    Some(result)
}
fn display_blocks(blocks: &Value) -> Value {
    if let Some(s) = blocks.as_str() {
        return json!(bounded(s));
    }
    json!(blocks.as_array().into_iter().flatten().take(128).map(|b|match b["type"].as_str(){
        Some("text")=>json!({"type":"text","text":bounded(b["text"].as_str().unwrap_or(""))}),
        Some("tool-call")=>json!({"type":"tool-call","id":b["id"],"name":b["name"],"arguments":bounded(b["arguments"].as_str().unwrap_or(""))}),
        Some("image")=>json!({"type":"image"}),
        Some("file")=>json!({"type":"file","name":b["name"]}),
        _=>Value::Null,
    }).collect::<Vec<_>>())
}
