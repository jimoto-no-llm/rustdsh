use super::*;
#[test]
fn only_valid_catalog_transports_and_ids_are_executable() {
    for id in [
        "settings/describe",
        "rdshTuiAdmin/catalog",
        "$events/result",
    ] {
        validate_action(&json!({"id":id,"transport":"rpc","mode":"unary"})).unwrap();
    }
    for id in [
        "../settings",
        "settings/../describe",
        "settings/describe?token=x",
        "settings/%2f",
    ] {
        assert!(validate_action(&json!({"id":id,"transport":"rpc","mode":"unary"})).is_err());
    }
    assert!(validate_action(&json!({"id":"http:test","transport":"http","mode":"unary","method":"POST","path":"/api/rdsh-settings/save"})).is_ok());
    for path in [
        "https://example.com/",
        "//example.com",
        "/api/settings/describe",
        "/api/rdsh-test/../other",
        "/api/rdsh-test?token=x",
    ] {
        assert!(validate_action(
            &json!({"id":"http:test","transport":"http","mode":"unary","method":"POST","path":path})
        )
        .is_err());
    }
    let action = json!({"id":"settings/describe","transport":"rpc","mode":"unary"});
    assert!(catalog_actions(&json!({"actions":[action.clone(),action]})).is_err());
}
#[test]
fn credentials_and_secret_fields_are_not_echoed_in_results() {
    let input = json!({"ns":"provider","patch":{"apiKey":"canary-key","nested":{"access_token":"canary-token"}},"unrelated":"shown"});
    let mut secrets = vec![];
    collect_secrets(&input, false, &mut secrets);
    let mut result = json!({"message":"canary-key failed canary-token","patch":{"client_secret":"hidden"},"tokensUsed":18});
    redact_admin(&mut result, &secrets);
    assert!(!result.to_string().contains("canary"));
    assert!(!result.to_string().contains("hidden"));
}
#[test]
fn stream_events_are_bounded_and_sequence_monotonic() {
    let state = Arc::new(Mutex::new(AdminState::default()));
    let (cancel, _) = watch::channel(false);
    let (input, _) = mpsc::channel(1);
    state.lock().unwrap().jobs.insert(
        "job".into(),
        Job {
            value: json!({"status":"running","events":[],"droppedEvents":0}),
            cancel,
            input,
            sequence: 1,
            event_sequence: 0,
            event_bytes: 0,
            uplink: false,
        },
    );
    for i in 0..200 {
        event(&state, "job", json!({"count":i}), &[]).unwrap();
    }
    let state = state.lock().unwrap();
    let value = &state.jobs["job"].value;
    assert_eq!(value["events"].as_array().unwrap().len(), MAX_EVENTS);
    assert_eq!(value["events"][0]["sequence"], 73);
    assert_eq!(value["droppedEvents"], 72);
}
#[test]
fn rpc_error_does_not_echo_host_diagnostic() {
    let error=rpc_response(json!({"type":"server-response","rpcId":"id","result":{"ok":false,"error":{"code":"settings/revision-conflict","message":"private secret"}}}),"id").unwrap_err().to_string();
    assert!(error.contains("revision-conflict"));
    assert!(!error.contains("private"));
    assert!(rpc_response(
        json!({"type":"server-response","rpcId":"other","result":{"ok":true,"value":4}}),
        "id"
    )
    .is_err());
}

fn test_remote(port: u16) -> Remote {
    Remote {
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        base: format!("http://127.0.0.1:{port}/").parse().unwrap(),
        cookie: "fixture=session".into(),
    }
}
fn test_state() -> Arc<Mutex<AdminState>> {
    let state = Arc::new(Mutex::new(AdminState::default()));
    let (cancel, _) = watch::channel(false);
    let (input, _) = mpsc::channel(1);
    state.lock().unwrap().jobs.insert(
        "job".into(),
        Job {
            value: json!({"status":"running","events":[],"droppedEvents":0}),
            cancel,
            input,
            sequence: 1,
            event_sequence: 0,
            event_bytes: 0,
            uplink: true,
        },
    );
    state
}
#[tokio::test]
async fn websocket_stream_uses_authenticated_gateway_and_sends_uplink_and_cancel() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let remote = test_remote(listener.local_addr().unwrap().port());
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (input_tx, input_rx) = mpsc::channel(4);
    let state = test_state();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_hdr_async(
            socket,
            // tungstenite fixes this callback's error type to an unboxed HTTP response.
            #[allow(clippy::result_large_err)]
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(request.uri().path(), "/api/remote.mux");
                assert_eq!(request.headers()["cookie"], "fixture=session");
                Ok(response)
            },
        )
        .await
        .unwrap();
        let open: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(open["endpoint"], "terminal/follow");
        assert_eq!(open["payload"]["args"]["request"]["terminalId"], "fixture");
        ws.send(Message::text(
            json!({"type":"item","streamId":"job","value":{"text":"hello"}}).to_string(),
        ))
        .await
        .unwrap();
        input_tx.send(json!({"message":"input"})).await.unwrap();
        let item: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(item["type"], "item");
        assert_eq!(item["value"]["message"], "input");
        cancel_tx.send(true).unwrap();
        let cancel: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(cancel["type"], "cancel");
    });
    let outcome = run_stream(
        &remote,
        &json!({"id":"terminal/follow"}),
        json!({"request":{"terminalId":"fixture"}}),
        &state,
        "job",
        cancel_rx,
        input_rx,
        &[],
    )
    .await
    .unwrap();
    assert!(matches!(outcome, JobResult::Cancelled));
    server.await.unwrap();
    assert_eq!(
        state.lock().unwrap().jobs["job"].value["events"][0]["value"]["text"],
        "hello"
    );
}
#[tokio::test]
async fn unary_failure_preserves_code_without_secret_diagnostic() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let remote = test_remote(listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 8192];
        let header_end = loop {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        assert!(headers.starts_with("POST /api/settings/update "));
        assert!(headers.to_lowercase().contains("cookie: fixture=session"));
        let len = headers
            .lines()
            .find_map(|l| {
                l.to_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        while bytes.len() < header_end + len {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
        }
        let body: Value = serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap();
        assert_eq!(body["payload"]["args"]["expectedRevision"], 7);
        let response=json!({"type":"server-response","rpcId":body["rpcId"],"result":{"ok":false,"error":{"code":"settings/conflict","message":"secret-canary"}}}).to_string();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
    });
    let error = run_unary(
        &remote,
        &json!({"id":"settings/update","transport":"rpc"}),
        json!({"ns":"test","patch":{},"expectedRevision":7}),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("settings/conflict"));
    assert!(!error.contains("secret-canary"));
    server.await.unwrap();
}

#[test]
fn short_explicit_secret_is_redacted_from_echoed_text() {
    let mut secrets = vec![];
    collect_secrets(&json!({"pin":"1234","value":"abcde"}), true, &mut secrets);
    let mut value = json!({"message":"PIN 1234 and abcde were supplied"});
    redact_admin(&mut value, &secrets);
    assert_eq!(
        value["message"],
        "PIN [REDACTED] and [REDACTED] were supplied"
    );
}
