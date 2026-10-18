//! Offline API contracts for fleet capacity and reviewed WarmPool changes.
use super::*;
use axum::http::{HeaderMap, Uri};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct Api {
    backend: KubernetesBackend,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Api {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn serve(app: Router) -> Api {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    Api {
        backend: KubernetesBackend {
            client: reqwest::Client::new(),
            api_server: Url::parse(&format!("http://{address}/")).unwrap(),
            token: "offline-contract".into(),
            namespace: "ns".into(),
            pool: Some("pool".into()),
        },
        server: tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    }
}

fn resource(name: &str) -> String {
    format!("/apis/{GROUP}/namespaces/ns/{name}")
}

fn pool() -> Value {
    json!({"metadata":{"resourceVersion":"42"},
        "spec":{"replicas":4,"sandboxTemplateRef":{"name":"template"}},
        "status":{"readyReplicas":2}})
}

#[test]
fn service_urls_support_ipv6_ipv4_and_dns_without_accepting_url_syntax() {
    for (host, port, expected) in [
        ("fd00::1", "443", "https://[fd00::1]/"),
        ("2001:db8::12", "6443", "https://[2001:db8::12]:6443/"),
        ("10.96.0.1", "443", "https://10.96.0.1/"),
        (
            "kubernetes.default.svc",
            "6443",
            "https://kubernetes.default.svc:6443/",
        ),
    ] {
        let url = Url::parse(&service_address(host, port).unwrap()).unwrap();
        assert_eq!(url.as_str(), expected);
    }
    for (host, port) in [
        ("", "443"),
        ("user@host", "443"),
        ("host/path", "443"),
        ("bad::ipv6", "443"),
        ("::1", "70000"),
    ] {
        assert_eq!(
            service_address(host, port).unwrap_err().kind,
            ErrorKind::Invalid
        );
    }
}

#[tokio::test]
async fn capacity_follows_pages_and_excludes_released_claims_without_inventing_usage() {
    let queries = Arc::new(Mutex::new(Vec::new()));
    let captured = queries.clone();
    let app = Router::new()
        .route(&resource("sandboxwarmpools/pool"), get(|| async { Json(pool()) }))
        .route(&resource("sandboxclaims"), get(move |uri: Uri, headers: HeaderMap| {
            let query: HashMap<String, String> = Url::parse(&format!("http://fixture/?{}", uri.query().unwrap_or_default()))
                .unwrap().query_pairs().into_owned().collect();
            captured.lock().unwrap().push(query.clone());
            async move {
                assert_eq!(headers["authorization"], "Bearer offline-contract");
                let ready = json!({"status":{"conditions":[{"type":"Ready","status":"True"}]}});
                let page = if query.contains_key("continue") {
                    assert_eq!(query["continue"], "next/with+symbols=");
                    json!({"metadata":{},"items":[ready]})
                } else {
                    json!({"metadata":{"continue":"next/with+symbols="},"items":[ready, {},
                        {"spec":{"lifecycle":{"shutdownPolicy":"Retain","shutdownTime":RETAIN_SHUTDOWN_TIME}}}]})
                };
                Json(page)
            }
        }));
    let api = serve(app).await;
    let capacity = api.backend.capacity().await.unwrap();
    assert_eq!(capacity.running_sandboxes, 2);
    assert_eq!(capacity.starting_sandboxes, 1);
    assert_eq!(capacity.warm_pool_available, 2);
    assert_eq!(capacity.desired_warm_pool, 4);
    assert!(capacity.cpu_used_millis.is_none());
    assert!(capacity.memory_used_bytes.is_none());
    assert!(capacity.llm_inflight.is_none());
    let queries = queries.lock().unwrap();
    assert_eq!(queries.len(), 2);
    for query in queries.iter() {
        assert_eq!(query["limit"], "500");
        assert_eq!(
            query["labelSelector"],
            format!("{MANAGED}=true,{POOL_LABEL}=pool")
        );
    }
}

#[tokio::test]
async fn a_malformed_capacity_page_is_unknown_instead_of_zero_capacity() {
    let app = Router::new()
        .route(
            &resource("sandboxwarmpools/pool"),
            get(|| async { Json(pool()) }),
        )
        .route(
            &resource("sandboxclaims"),
            get(|| async { Json(json!({"metadata":{}})) }),
        );
    let api = serve(app).await;
    assert_eq!(
        api.backend.capacity().await.unwrap_err().kind,
        ErrorKind::Unknown
    );
}

#[tokio::test]
async fn pool_apply_preserves_reviewed_version_and_rejects_stale_or_overbroad_plans() {
    let patches = Arc::new(Mutex::new(Vec::new()));
    let captured = patches.clone();
    let app = Router::new().route(
        &resource("sandboxwarmpools/pool"),
        get(|| async { Json(pool()) }).patch(move |headers: HeaderMap, Json(body): Json<Value>| {
            captured.lock().unwrap().push(body);
            async move {
                assert_eq!(headers["content-type"], "application/json-patch+json");
                Json(json!({"metadata":{"resourceVersion":"43"}}))
            }
        }),
    );
    let api = serve(app).await;
    let plan = api
        .backend
        .pool_plan("pool".into(), "template".into(), 0)
        .await
        .unwrap();
    assert_eq!(plan.expected_resource_version.as_deref(), Some("42"));
    let mut stale = plan.clone();
    stale.expected_resource_version = Some("41".into());
    assert_eq!(
        api.backend.apply_pool_plan(stale).await.unwrap_err().kind,
        ErrorKind::Conflict
    );
    let mut replacement = plan.clone();
    replacement.template = "other-template".into();
    assert_eq!(
        api.backend
            .apply_pool_plan(replacement)
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Conflict
    );
    let mut wrong_namespace = plan.clone();
    wrong_namespace.namespace = "another-tenant".into();
    assert_eq!(
        api.backend
            .apply_pool_plan(wrong_namespace)
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Invalid
    );
    let mut unapproved_scale = plan.clone();
    unapproved_scale.replicas = 2;
    assert_eq!(
        api.backend
            .apply_pool_plan(unapproved_scale)
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Forbidden
    );
    assert!(patches.lock().unwrap().is_empty());
    let result = api.backend.apply_pool_plan(plan).await.unwrap();
    assert_eq!(
        result,
        json!({"applied":true,"name":"pool","resource_version":"43"})
    );
    assert_eq!(
        *patches.lock().unwrap(),
        vec![json!([
            {"op":"test","path":"/metadata/resourceVersion","value":"42"},
            {"op":"add","path":"/spec/replicas","value":0}
        ])]
    );
}

#[tokio::test]
async fn creating_a_pool_uses_the_reviewed_template_and_does_not_replace_a_missing_version() {
    let creations = Arc::new(Mutex::new(Vec::new()));
    let captured = creations.clone();
    let app = Router::new()
        .route(
            &resource("sandboxwarmpools/pool"),
            get(|| async { (StatusCode::NOT_FOUND, Json(json!({}))) }),
        )
        .route(
            &resource("sandboxwarmpools"),
            post(move |Json(body): Json<Value>| {
                captured.lock().unwrap().push(body);
                async {
                    (
                        StatusCode::CREATED,
                        Json(json!({"metadata":{"resourceVersion":"1"}})),
                    )
                }
            }),
        );
    let api = serve(app).await;
    assert_eq!(
        api.backend
            .pool_plan("../unsafe".into(), "template".into(), 1)
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Invalid
    );
    assert_eq!(
        api.backend
            .pool_plan("pool".into(), "template".into(), 10_001)
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Invalid
    );
    let plan = api
        .backend
        .pool_plan("pool".into(), "template".into(), 1)
        .await
        .unwrap();
    assert!(plan.expected_resource_version.is_none());
    let mut disappeared = plan.clone();
    disappeared.expected_resource_version = Some("old-version".into());
    assert_eq!(
        api.backend
            .apply_pool_plan(disappeared)
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Conflict
    );
    assert!(creations.lock().unwrap().is_empty());
    assert_eq!(
        api.backend.apply_pool_plan(plan).await.unwrap()["applied"],
        true
    );
    assert_eq!(
        *creations.lock().unwrap(),
        vec![json!({
            "apiVersion":GROUP,"kind":"SandboxWarmPool",
            "metadata":{"name":"pool","namespace":"ns"},
            "spec":{"replicas":1,"sandboxTemplateRef":{"name":"template"}}
        })]
    );
}
