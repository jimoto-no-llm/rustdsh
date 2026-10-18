use super::*;
use reqwest::{Method, StatusCode, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

const GROUP: &str = "extensions.agents.x-k8s.io/v1beta1";
const OWNER: &str = "cloud.rdsh.dev/owner-digest";
const MANAGED: &str = "cloud.rdsh.dev/managed";
const POOL_LABEL: &str = "cloud.rdsh.dev/pool";
const RETAIN_SHUTDOWN_TIME: &str = "1970-01-01T00:00:00Z";
const MAX_EXEC_OUTPUT: usize = 1024 * 1024;

#[cfg(test)]
#[path = "kubernetes_contract_tests.rs"]
mod contract_tests;

pub struct KubernetesBackend {
    client: reqwest::Client,
    api_server: Url,
    token: String,
    namespace: String,
    pool: Option<String>,
}

fn dns_name(value: &str) -> bool {
    value.len() <= 63
        && !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn hash(input: &[u8]) -> String {
    Sha256::digest(input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn owner_digest(request: &SandboxRequest) -> String {
    hash(&serde_json::to_vec(request).expect("request serialization"))
}

fn claim_name(namespace: &str, pool: &str, request: &SandboxRequest) -> String {
    // One stable name per Attempt, even when a caller changes its retry key.
    let key = format!(
        "{namespace}\0{pool}\0{}\0{}\0{}",
        request.run_id, request.task_id, request.attempt_id
    );
    format!("rdsh-{}", &hash(key.as_bytes())[..40])
}

fn field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

fn string_field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    field(value, path).and_then(Value::as_str)
}

impl KubernetesBackend {
    pub fn from_service_account(namespace: String, pool: Option<String>) -> CloudResult<Self> {
        if !dns_name(&namespace) || pool.as_deref().is_some_and(|value| !dns_name(value)) {
            return Err(CloudError::new(
                ErrorKind::Invalid,
                "invalid namespace or pool name",
            ));
        }
        let server = if let Ok(value) = std::env::var("RDSH_CLOUD_API_SERVER") {
            value
        } else {
            let host = std::env::var("KUBERNETES_SERVICE_HOST").map_err(|_| {
                CloudError::new(
                    ErrorKind::Unavailable,
                    "Kubernetes service host is not configured",
                )
            })?;
            let port =
                std::env::var("KUBERNETES_SERVICE_PORT_HTTPS").unwrap_or_else(|_| "443".into());
            if !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':')
                || port.parse::<u16>().is_err()
            {
                return Err(CloudError::new(
                    ErrorKind::Invalid,
                    "invalid Kubernetes service address",
                ));
            }
            format!("https://{host}:{port}")
        };
        let api_server = Url::parse(&server)
            .map_err(|_| CloudError::new(ErrorKind::Invalid, "invalid Kubernetes API URL"))?;
        if api_server.scheme() != "https"
            || api_server.host_str().is_none()
            || api_server.path() != "/"
            || api_server.query().is_some()
        {
            return Err(CloudError::new(
                ErrorKind::Invalid,
                "Kubernetes API URL must be an HTTPS origin",
            ));
        }
        let token_path = std::env::var("RDSH_CLOUD_TOKEN_FILE")
            .unwrap_or_else(|_| "/var/run/secrets/kubernetes.io/serviceaccount/token".into());
        let ca_path = std::env::var("RDSH_CLOUD_CA_FILE")
            .unwrap_or_else(|_| "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt".into());
        let token = std::fs::read_to_string(token_path).map_err(|_| {
            CloudError::new(
                ErrorKind::Unavailable,
                "Kubernetes token file is unavailable",
            )
        })?;
        let ca = std::fs::read(ca_path).map_err(|_| {
            CloudError::new(ErrorKind::Unavailable, "Kubernetes CA file is unavailable")
        })?;
        let certificate = reqwest::Certificate::from_pem(&ca).map_err(|_| {
            CloudError::new(ErrorKind::Invalid, "Kubernetes CA certificate is invalid")
        })?;
        let client = reqwest::Client::builder()
            .add_root_certificate(certificate)
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| {
                CloudError::new(ErrorKind::Unavailable, "cannot create Kubernetes client")
            })?;
        if token.trim().is_empty() {
            return Err(CloudError::new(
                ErrorKind::Invalid,
                "Kubernetes token file is empty",
            ));
        }
        Ok(Self {
            client,
            api_server,
            token: token.trim().into(),
            namespace,
            pool,
        })
    }

    fn url(&self, path: &str) -> Url {
        self.api_server.join(path).expect("static Kubernetes path")
    }

    fn resource_path(&self, resource: &str, name: Option<&str>) -> String {
        let mut path = format!("/apis/{GROUP}/namespaces/{}/{resource}", self.namespace);
        if let Some(name) = name {
            path.push('/');
            path.push_str(name);
        }
        path
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
        content_type: Option<&str>,
    ) -> CloudResult<(StatusCode, Value)> {
        let mut request = self.client.request(method, url).bearer_auth(&self.token);
        if let Some(body) = body {
            request =
                request
                    .body(serde_json::to_vec(&body).map_err(|_| {
                        CloudError::new(ErrorKind::Invalid, "invalid JSON request")
                    })?);
            request = request.header("content-type", content_type.unwrap_or("application/json"));
        }
        let response = request.send().await.map_err(|_| {
            CloudError::new(
                ErrorKind::Unknown,
                "Kubernetes API request outcome is unknown",
            )
        })?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| {
            CloudError::new(
                ErrorKind::Unknown,
                "Kubernetes API response could not be read",
            )
        })?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(CloudError::new(
                ErrorKind::Unknown,
                "Kubernetes API response exceeds limit",
            ));
        }
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok((status, value))
    }

    async fn get(&self, path: &str) -> CloudResult<(StatusCode, Value)> {
        self.send(Method::GET, self.url(path), None, None).await
    }

    fn check_status(status: StatusCode) -> CloudResult<()> {
        if status.is_success() {
            return Ok(());
        }
        let kind = match status {
            StatusCode::CONFLICT => ErrorKind::Conflict,
            StatusCode::NOT_FOUND => ErrorKind::NotFound,
            StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => ErrorKind::Forbidden,
            _ => ErrorKind::Unavailable,
        };
        Err(CloudError::new(
            kind,
            format!("Kubernetes API status {status}"),
        ))
    }

    fn pool_name(&self) -> CloudResult<&str> {
        self.pool
            .as_deref()
            .ok_or_else(|| CloudError::new(ErrorKind::Invalid, "--pool is required"))
    }

    pub async fn doctor(&self) -> CloudResult<Value> {
        let (status, _) = self.get("/version").await?;
        Self::check_status(status)?;
        Ok(
            json!({"backend":"kubernetes","api_reachable":true,"namespace":self.namespace,
            "pool":self.pool,"agent_sandbox_checked":false,"exec_transport":"kubectl_one_shot"}),
        )
    }

    pub async fn pool_plan(
        &self,
        name: String,
        template: String,
        replicas: u32,
    ) -> CloudResult<PoolPlan> {
        if !dns_name(&name) || !dns_name(&template) || replicas > 10_000 {
            return Err(CloudError::new(ErrorKind::Invalid, "invalid pool plan"));
        }
        let path = self.resource_path("sandboxwarmpools", Some(&name));
        let (status, current) = self.get(&path).await?;
        let expected_resource_version = match status {
            StatusCode::NOT_FOUND => None,
            s if s.is_success() => {
                string_field(&current, &["metadata", "resourceVersion"]).map(str::to_owned)
            }
            s => {
                Self::check_status(s)?;
                unreachable!()
            }
        };
        Ok(PoolPlan {
            namespace: self.namespace.clone(),
            name,
            template,
            replicas,
            expected_resource_version,
        })
    }

    pub async fn apply_pool_plan(&self, plan: PoolPlan) -> CloudResult<Value> {
        if plan.namespace != self.namespace
            || !dns_name(&plan.name)
            || !dns_name(&plan.template)
            || plan.replicas > 10_000
        {
            return Err(CloudError::new(
                ErrorKind::Invalid,
                "pool plan does not match namespace or is invalid",
            ));
        }
        if plan.replicas > 1 {
            return Err(CloudError::new(
                ErrorKind::Forbidden,
                "initial pool apply is limited to one sandbox until capacity and cost approval are implemented",
            ));
        }
        let path = self.resource_path("sandboxwarmpools", Some(&plan.name));
        let (status, current) = self.get(&path).await?;
        let (status, result) = if status == StatusCode::NOT_FOUND {
            if plan.expected_resource_version.is_some() {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "pool disappeared since plan",
                ));
            }
            let body = json!({"apiVersion":GROUP,"kind":"SandboxWarmPool",
                "metadata":{"name":plan.name,"namespace":plan.namespace},
                "spec":{"replicas":plan.replicas,"sandboxTemplateRef":{"name":plan.template}}});
            self.send(
                Method::POST,
                self.url(&self.resource_path("sandboxwarmpools", None)),
                Some(body),
                None,
            )
            .await?
        } else {
            Self::check_status(status)?;
            if string_field(&current, &["metadata", "resourceVersion"])
                != plan.expected_resource_version.as_deref()
                || plan.expected_resource_version.is_none()
            {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "pool changed since plan",
                ));
            }
            if string_field(&current, &["spec", "sandboxTemplateRef", "name"])
                != Some(plan.template.as_str())
            {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "pool template differs; refusing replacement",
                ));
            }
            let patch = json!([{"op":"test","path":"/metadata/resourceVersion","value":plan.expected_resource_version},
                {"op":"add","path":"/spec/replicas","value":plan.replicas}]);
            self.send(
                Method::PATCH,
                self.url(&path),
                Some(patch),
                Some("application/json-patch+json"),
            )
            .await?
        };
        Self::check_status(status)?;
        Ok(
            json!({"applied":true,"name":plan.name,"resource_version":string_field(&result,&["metadata","resourceVersion"])}),
        )
    }

    async fn verify_template(&self, request: &SandboxRequest) -> CloudResult<()> {
        let pool = self.pool_name()?;
        let (status, pool_json) = self
            .get(&self.resource_path("sandboxwarmpools", Some(pool)))
            .await?;
        Self::check_status(status)?;
        let template = string_field(&pool_json, &["spec", "sandboxTemplateRef", "name"])
            .ok_or_else(|| CloudError::new(ErrorKind::Invalid, "pool has no template"))?;
        if !dns_name(template) {
            return Err(CloudError::new(
                ErrorKind::Invalid,
                "invalid pool template name",
            ));
        }
        let (status, template_json) = self
            .get(&self.resource_path("sandboxtemplates", Some(template)))
            .await?;
        Self::check_status(status)?;
        let pod = field(&template_json, &["spec", "podTemplate", "spec"])
            .ok_or_else(|| CloudError::new(ErrorKind::Invalid, "template has no pod spec"))?;
        let containers = pod
            .get("containers")
            .and_then(Value::as_array)
            .ok_or_else(|| CloudError::new(ErrorKind::Invalid, "template has no containers"))?;
        let container = containers
            .iter()
            .find(|c| {
                c.get("name").and_then(Value::as_str) == Some(request.container_name.as_str())
            })
            .ok_or_else(|| {
                CloudError::new(ErrorKind::Invalid, "worker container not found in template")
            })?;
        if container.get("image").and_then(Value::as_str) != Some(request.image_digest.as_str()) {
            return Err(CloudError::new(
                ErrorKind::Conflict,
                "template image digest differs from request",
            ));
        }
        let non_root = field(pod, &["securityContext", "runAsNonRoot"]).and_then(Value::as_bool)
            == Some(true)
            || field(container, &["securityContext", "runAsNonRoot"]).and_then(Value::as_bool)
                == Some(true);
        let volumes = pod.get("volumes").and_then(Value::as_array);
        let mounts = container.get("volumeMounts").and_then(Value::as_array);
        let isolated_mount = |name: &str, path: &str| {
            volumes.is_some_and(|items| {
                items.iter().any(|v| {
                    v.get("name").and_then(Value::as_str) == Some(name)
                        && v.get("emptyDir").is_some()
                })
            }) && mounts.is_some_and(|items| {
                items.iter().any(|m| {
                    m.get("name").and_then(Value::as_str) == Some(name)
                        && m.get("mountPath").and_then(Value::as_str) == Some(path)
                })
            })
        };
        if !non_root
            || !dns_name(&request.container_name)
            || !isolated_mount("home", "/home/node")
            || !isolated_mount("workspace", "/workspace")
            || ["cpu", "memory"].iter().any(|name| {
                field(container, &["resources", "requests", name]).is_none()
                    || field(container, &["resources", "limits", name]).is_none()
            })
            || pod
                .get("automountServiceAccountToken")
                .and_then(Value::as_bool)
                != Some(false)
            || field(container, &["securityContext", "privileged"]).and_then(Value::as_bool)
                == Some(true)
            || field(container, &["securityContext", "allowPrivilegeEscalation"])
                .and_then(Value::as_bool)
                != Some(false)
            || field(container, &["securityContext", "readOnlyRootFilesystem"])
                .and_then(Value::as_bool)
                != Some(true)
            || ["hostNetwork", "hostPID", "hostIPC"]
                .iter()
                .any(|name| pod.get(name).and_then(Value::as_bool) == Some(true))
            || pod
                .get("volumes")
                .and_then(Value::as_array)
                .is_some_and(|volumes| volumes.iter().any(|v| v.get("hostPath").is_some()))
            || !field(&template_json, &["spec", "networkPolicy"]).is_some_and(Value::is_object)
        {
            return Err(CloudError::new(
                ErrorKind::Forbidden,
                "template does not meet minimum isolation checks",
            ));
        }
        Ok(())
    }

    fn initial_lease(&self, request: SandboxRequest) -> CloudResult<SandboxLease> {
        let pool = self.pool_name()?;
        let name = claim_name(&self.namespace, pool, &request);
        Ok(SandboxLease {
            namespace: self.namespace.clone(),
            pool: pool.into(),
            request,
            sandbox_id: name.clone(),
            lease_id: name,
            generation: 0,
            fencing_token: None,
            phase: LeasePhase::Unknown,
            allocation: AllocationKind::Unknown,
        })
    }

    fn verify_claim(&self, lease: &SandboxLease, claim: &Value) -> CloudResult<()> {
        let digest = owner_digest(&lease.request);
        if lease.namespace != self.namespace
            || self.pool.as_deref() != Some(lease.pool.as_str())
            || string_field(claim, &["metadata", "name"]) != Some(lease.lease_id.as_str())
            || string_field(claim, &["metadata", "annotations", OWNER]) != Some(digest.as_str())
            || string_field(claim, &["spec", "warmPoolRef", "name"]) != Some(lease.pool.as_str())
        {
            return Err(CloudError::new(
                ErrorKind::Conflict,
                "claim owner or pool differs",
            ));
        }
        if let Some(token) = &lease.fencing_token {
            if string_field(claim, &["metadata", "uid"]) != Some(token) {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "claim UID fencing token differs",
                ));
            }
        }
        Ok(())
    }

    fn release_requested(claim: &Value) -> bool {
        string_field(claim, &["spec", "lifecycle", "shutdownPolicy"]) == Some("Retain")
            && string_field(claim, &["spec", "lifecycle", "shutdownTime"])
                == Some(RETAIN_SHUTDOWN_TIME)
    }

    async fn observed_lease(
        &self,
        mut lease: SandboxLease,
        claim: &Value,
    ) -> CloudResult<SandboxLease> {
        self.verify_claim(&lease, claim)?;
        lease.fencing_token = string_field(claim, &["metadata", "uid"]).map(str::to_owned);
        lease.generation = field(claim, &["metadata", "generation"])
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if let Some(name) = string_field(claim, &["status", "sandbox", "name"]) {
            lease.sandbox_id = name.into();
            if dns_name(name) {
                let path = format!(
                    "/apis/agents.x-k8s.io/v1beta1/namespaces/{}/sandboxes/{name}",
                    self.namespace
                );
                if let Ok((status, sandbox)) = self.get(&path).await {
                    if status.is_success() {
                        lease.allocation = match string_field(
                            &sandbox,
                            &["metadata", "labels", "agents.x-k8s.io/launch-type"],
                        ) {
                            Some("warm") => AllocationKind::Warm,
                            Some("cold") => AllocationKind::Cold,
                            _ => AllocationKind::Unknown,
                        };
                    }
                }
            }
        }
        let ready = field(claim, &["status", "conditions"])
            .and_then(Value::as_array)
            .is_some_and(|conditions| {
                conditions.iter().any(|c| {
                    c.get("type") == Some(&json!("Ready"))
                        && c.get("status") == Some(&json!("True"))
                })
            });
        lease.phase = if Self::release_requested(claim) {
            let expired = field(claim, &["status", "conditions"])
                .and_then(Value::as_array)
                .is_some_and(|conditions| {
                    conditions.iter().any(|c| {
                        c.get("type") == Some(&json!("Ready"))
                            && c.get("reason") == Some(&json!("ClaimExpired"))
                    })
                });
            if expired && string_field(claim, &["status", "sandbox", "name"]).is_none() {
                LeasePhase::Released
            } else {
                LeasePhase::Releasing
            }
        } else if claim
            .get("metadata")
            .and_then(|m| m.get("deletionTimestamp"))
            .is_some()
        {
            LeasePhase::Unknown
        } else if ready && lease.fencing_token.is_some() {
            LeasePhase::Ready
        } else {
            LeasePhase::Starting
        };
        Ok(lease)
    }
}

impl CloudBackend for KubernetesBackend {
    fn capacity(&self) -> CloudFuture<'_, Capacity> {
        Box::pin(async move {
            let pool = self.pool_name()?;
            let (status, pool_json) = self
                .get(&self.resource_path("sandboxwarmpools", Some(pool)))
                .await?;
            Self::check_status(status)?;
            let desired = field(&pool_json, &["spec", "replicas"])
                .and_then(Value::as_u64)
                .unwrap_or(1);
            let warm = field(&pool_json, &["status", "readyReplicas"])
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let mut starting = 0_u64;
            let mut running = 0_u64;
            let mut continuation = String::new();
            loop {
                let mut url = self.url(&self.resource_path("sandboxclaims", None));
                url.query_pairs_mut()
                    .append_pair(
                        "labelSelector",
                        &format!("{MANAGED}=true,{POOL_LABEL}={pool}"),
                    )
                    .append_pair("limit", "500");
                if !continuation.is_empty() {
                    url.query_pairs_mut().append_pair("continue", &continuation);
                }
                let (status, list) = self.send(Method::GET, url, None, None).await?;
                Self::check_status(status)?;
                let items = field(&list, &["items"])
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        CloudError::new(ErrorKind::Unknown, "claim list has no items")
                    })?;
                for item in items {
                    if Self::release_requested(item) {
                        continue;
                    }
                    let ready = field(item, &["status", "conditions"])
                        .and_then(Value::as_array)
                        .is_some_and(|conditions| {
                            conditions.iter().any(|c| {
                                c.get("type") == Some(&json!("Ready"))
                                    && c.get("status") == Some(&json!("True"))
                            })
                        });
                    if ready {
                        running += 1;
                    } else {
                        starting += 1;
                    }
                }
                continuation = string_field(&list, &["metadata", "continue"])
                    .unwrap_or("")
                    .into();
                if continuation.is_empty() {
                    break;
                }
            }
            Ok(Capacity {
                queued_tasks: None,
                starting_sandboxes: starting,
                running_sandboxes: running,
                warm_pool_available: warm,
                desired_warm_pool: desired,
                llm_inflight: None,
                api_rate_limited: None,
                failed_allocations: None,
                unknown_allocations: None,
                orphan_sandboxes: None,
                cpu_requested_millis: None,
                cpu_used_millis: None,
                memory_requested_bytes: None,
                memory_used_bytes: None,
            })
        })
    }

    fn acquire(&self, request: SandboxRequest) -> CloudFuture<'_, SandboxLease> {
        Box::pin(async move {
            request.validate()?;
            let mut lease = self.initial_lease(request)?;
            let claim_path = self.resource_path("sandboxclaims", Some(&lease.lease_id));
            let (existing_status, existing) = self.get(&claim_path).await?;
            if existing_status.is_success() {
                self.verify_claim(&lease, &existing)?;
                if Self::release_requested(&existing) {
                    return Err(CloudError::new(
                        ErrorKind::Conflict,
                        "attempt was already released",
                    ));
                }
                return self.observed_lease(lease, &existing).await;
            }
            if existing_status != StatusCode::NOT_FOUND {
                Self::check_status(existing_status)?;
            }
            self.verify_template(&lease.request).await?;
            let body = json!({"apiVersion":GROUP,"kind":"SandboxClaim",
                "metadata":{"name":lease.lease_id,"namespace":self.namespace,
                    "labels":{(MANAGED):"true",(POOL_LABEL):lease.pool},
                    "annotations":{(OWNER):owner_digest(&lease.request),
                        "cloud.rdsh.dev/run-id":lease.request.run_id,
                        "cloud.rdsh.dev/task-id":lease.request.task_id,
                        "cloud.rdsh.dev/attempt-id":lease.request.attempt_id,
                        "cloud.rdsh.dev/worker-id":lease.request.worker_id}},
                "spec":{"warmPoolRef":{"name":lease.pool}}});
            let result = self
                .send(
                    Method::POST,
                    self.url(&self.resource_path("sandboxclaims", None)),
                    Some(body),
                    None,
                )
                .await;
            let (status, claim) = match result {
                Ok((StatusCode::CONFLICT, _)) => match self.get(&claim_path).await {
                    Ok(value) => value,
                    Err(error) if error.kind == ErrorKind::Unknown => return Ok(lease),
                    Err(error) => return Err(error),
                },
                Ok(value) => value,
                Err(error) if error.kind == ErrorKind::Unknown => return Ok(lease),
                Err(error) => return Err(error),
            };
            Self::check_status(status)?;
            self.verify_claim(&lease, &claim)?;
            if Self::release_requested(&claim) {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "attempt was already released",
                ));
            }
            lease = self.observed_lease(lease, &claim).await?;
            Ok(lease)
        })
    }

    fn inspect<'a>(&'a self, lease: &'a SandboxLease) -> CloudFuture<'a, SandboxStatus> {
        Box::pin(async move {
            lease.request.validate()?;
            if lease.namespace != self.namespace
                || self.pool.as_deref() != Some(lease.pool.as_str())
                || lease.lease_id != claim_name(&lease.namespace, &lease.pool, &lease.request)
            {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "lease identity differs from backend",
                ));
            }
            let (status, claim) = self
                .get(&self.resource_path("sandboxclaims", Some(&lease.lease_id)))
                .await?;
            if status == StatusCode::NOT_FOUND {
                let mut observed = lease.clone();
                observed.phase = if lease.fencing_token.is_some() {
                    LeasePhase::Missing
                } else {
                    LeasePhase::Unknown
                };
                return Ok(SandboxStatus {
                    lease: observed,
                    reason: "claim_not_found".into(),
                });
            }
            Self::check_status(status)?;
            let observed = self.observed_lease(lease.clone(), &claim).await?;
            let reason = if observed.phase == LeasePhase::Ready {
                "claim_ready"
            } else {
                "claim_pending_or_unknown"
            };
            Ok(SandboxStatus {
                lease: observed,
                reason: reason.into(),
            })
        })
    }

    fn execute<'a>(
        &'a self,
        lease: &'a SandboxLease,
        command: ExecRequest,
    ) -> CloudFuture<'a, ExecResult> {
        Box::pin(async move {
            if command.argv.is_empty()
                || command.timeout_seconds == 0
                || command.timeout_seconds > 3600
            {
                return Err(CloudError::new(ErrorKind::Invalid, "invalid exec request"));
            }
            let observed = self.inspect(lease).await?;
            if observed.lease.phase != LeasePhase::Ready || !dns_name(&observed.lease.sandbox_id) {
                return Err(CloudError::new(ErrorKind::Conflict, "sandbox is not ready"));
            }
            let kubeconfig = std::env::var("RDSH_CLOUD_KUBECONFIG")
                .map(PathBuf::from)
                .map_err(|_| {
                    CloudError::new(
                        ErrorKind::Unavailable,
                        "RDSH_CLOUD_KUBECONFIG is required for one-shot exec",
                    )
                })?;
            if !kubeconfig.is_absolute() || !kubeconfig.is_file() {
                return Err(CloudError::new(
                    ErrorKind::Invalid,
                    "KUBECONFIG must be an existing absolute path",
                ));
            }
            let config_server = Command::new("kubectl")
                .arg("--kubeconfig")
                .arg(&kubeconfig)
                .args([
                    "config",
                    "view",
                    "--minify",
                    "-o",
                    "jsonpath={.clusters[0].cluster.server}",
                ])
                .output()
                .await
                .map_err(|_| CloudError::new(ErrorKind::Unavailable, "kubectl is unavailable"))?;
            let server = String::from_utf8_lossy(&config_server.stdout);
            if !config_server.status.success()
                || server.trim_end_matches('/') != self.api_server.as_str().trim_end_matches('/')
            {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "kubectl context API server differs from claim backend",
                ));
            }
            let mut child = Command::new("kubectl");
            child
                .arg("--kubeconfig")
                .arg(&kubeconfig)
                .arg("--namespace")
                .arg(&self.namespace)
                .arg("exec")
                .arg(&observed.lease.sandbox_id)
                .arg("-c")
                .arg(&lease.request.container_name)
                .arg("--")
                .args(&command.argv)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = child.spawn().map_err(|_| {
                CloudError::new(ErrorKind::Unavailable, "kubectl exec could not start")
            })?;
            let stdout = tokio::spawn(drain_limited(child.stdout.take().unwrap()));
            let stderr = tokio::spawn(drain_limited(child.stderr.take().unwrap()));
            let status = match tokio::time::timeout(
                Duration::from_secs(command.timeout_seconds),
                child.wait(),
            )
            .await
            {
                Ok(Ok(status)) => status,
                _ => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(CloudError::new(
                        ErrorKind::Unknown,
                        "exec outcome is unknown after timeout or transport failure",
                    ));
                }
            };
            let (out, out_truncated) = stdout
                .await
                .map_err(|_| CloudError::new(ErrorKind::Unknown, "stdout collection failed"))?;
            let (err, err_truncated) = stderr
                .await
                .map_err(|_| CloudError::new(ErrorKind::Unknown, "stderr collection failed"))?;
            Ok(ExecResult {
                exit_code: status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out).into_owned(),
                stderr: String::from_utf8_lossy(&err).into_owned(),
                truncated: out_truncated || err_truncated,
            })
        })
    }

    fn release<'a>(&'a self, lease: &'a SandboxLease) -> CloudFuture<'a, ()> {
        Box::pin(async move {
            let observed = self.inspect(lease).await?;
            if observed.lease.phase == LeasePhase::Releasing
                || observed.lease.phase == LeasePhase::Released
            {
                return Ok(());
            }
            if observed.lease.phase == LeasePhase::Unknown
                || observed.lease.phase == LeasePhase::Missing
            {
                return Err(CloudError::new(
                    ErrorKind::Unknown,
                    "claim state is unknown or missing; no release performed",
                ));
            }
            let uid =
                observed.lease.fencing_token.as_deref().ok_or_else(|| {
                    CloudError::new(ErrorKind::Unknown, "claim UID is not observed")
                })?;
            let path = self.resource_path("sandboxclaims", Some(&lease.lease_id));
            let (get_status, claim) = self.get(&path).await?;
            Self::check_status(get_status)?;
            self.verify_claim(lease, &claim)?;
            let resource_version = string_field(&claim, &["metadata", "resourceVersion"])
                .ok_or_else(|| {
                    CloudError::new(ErrorKind::Unknown, "claim resourceVersion is missing")
                })?;
            let body = json!([
                {"op":"test","path":"/metadata/uid","value":uid},
                {"op":"test","path":"/metadata/resourceVersion","value":resource_version},
                {"op":"add","path":"/spec/lifecycle",
                    "value":{"shutdownPolicy":"Retain","shutdownTime":RETAIN_SHUTDOWN_TIME}}
            ]);
            let (status, _) = self
                .send(
                    Method::PATCH,
                    self.url(&path),
                    Some(body),
                    Some("application/json-patch+json"),
                )
                .await?;
            Self::check_status(status)?;
            Ok(())
        })
    }
}

async fn drain_limited<R: AsyncRead + Unpin>(mut reader: R) -> (Vec<u8>, bool) {
    let mut retained = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let remaining = MAX_EXEC_OUTPUT.saturating_sub(retained.len());
                retained.extend_from_slice(&buffer[..n.min(remaining)]);
                truncated |= n > remaining;
            }
        }
    }
    (retained, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MockState {
        claim: Option<Value>,
        creates: u32,
        create_response_delay_ms: u64,
    }

    type Shared = Arc<Mutex<MockState>>;

    async fn get_pool() -> Json<Value> {
        Json(
            json!({"spec":{"replicas":1,"sandboxTemplateRef":{"name":"template"}},
            "status":{"readyReplicas":1}}),
        )
    }

    async fn get_template() -> Json<Value> {
        Json(
            json!({"spec":{"podTemplate":{"spec":{"automountServiceAccountToken":false,
            "securityContext":{"runAsNonRoot":true},
            "volumes":[{"name":"home","emptyDir":{}},{"name":"workspace","emptyDir":{}}],
            "containers":[{"name":"worker","image":format!("x@sha256:{}", "0".repeat(64)),
                "securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true},
                "resources":{"requests":{"cpu":"500m","memory":"1Gi"},
                    "limits":{"cpu":"2","memory":"4Gi"}},
                "volumeMounts":[{"name":"home","mountPath":"/home/node"},
                    {"name":"workspace","mountPath":"/workspace"}]}]}},
            "networkPolicy":{"ingress":[],"egress":[]}}}),
        )
    }

    async fn get_claim(State(state): State<Shared>) -> (StatusCode, Json<Value>) {
        match state.lock().unwrap().claim.clone() {
            Some(claim) => (StatusCode::OK, Json(claim)),
            None => (StatusCode::NOT_FOUND, Json(Value::Null)),
        }
    }

    async fn create_claim(
        State(state): State<Shared>,
        Json(mut claim): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        let delay = {
            let mut state = state.lock().unwrap();
            if state.claim.is_some() {
                return (StatusCode::CONFLICT, Json(Value::Null));
            }
            claim["metadata"]["uid"] = json!("uid-1");
            claim["metadata"]["generation"] = json!(1);
            claim["metadata"]["resourceVersion"] = json!("1");
            state.creates += 1;
            state.claim = Some(claim.clone());
            state.create_response_delay_ms
        };
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        (StatusCode::CREATED, Json(claim))
    }

    async fn patch_claim(
        State(state): State<Shared>,
        Json(patch): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        let mut state = state.lock().unwrap();
        let Some(claim) = state.claim.as_mut() else {
            return (StatusCode::NOT_FOUND, Json(Value::Null));
        };
        if patch[0]["value"] != "uid-1" || patch[1]["value"] != claim["metadata"]["resourceVersion"]
        {
            return (StatusCode::CONFLICT, Json(Value::Null));
        }
        claim["spec"]["lifecycle"] = patch[2]["value"].clone();
        claim["metadata"]["resourceVersion"] = json!("2");
        (StatusCode::OK, Json(claim.clone()))
    }

    async fn mock_backend(
        request: &SandboxRequest,
    ) -> (KubernetesBackend, Shared, tokio::task::JoinHandle<()>) {
        let state = Arc::new(Mutex::new(MockState::default()));
        let claim = claim_name("ns", "pool", request);
        let collection = format!("/apis/{GROUP}/namespaces/ns/sandboxclaims");
        let app = Router::new()
            .route(
                &format!("/apis/{GROUP}/namespaces/ns/sandboxwarmpools/pool"),
                get(get_pool),
            )
            .route(
                &format!("/apis/{GROUP}/namespaces/ns/sandboxtemplates/template"),
                get(get_template),
            )
            .route(&collection, post(create_claim))
            .route(
                &format!("{collection}/{claim}"),
                get(get_claim).patch(patch_claim),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let backend = KubernetesBackend {
            client: reqwest::Client::new(),
            api_server: Url::parse(&format!("http://{address}/")).unwrap(),
            token: "test-only".into(),
            namespace: "ns".into(),
            pool: Some("pool".into()),
        };
        (backend, state, server)
    }

    fn request() -> SandboxRequest {
        SandboxRequest {
            run_id: "run".into(),
            task_id: "task".into(),
            attempt_id: "a".into(),
            worker_id: "w".into(),
            idempotency_key: "key".into(),
            container_name: "worker".into(),
            image_digest: format!("x@sha256:{}", "0".repeat(64)),
        }
    }

    #[test]
    fn deterministic_claim_name_and_dns_validation() {
        let request = request();
        let name = claim_name("ns", "pool", &request);
        assert!(dns_name(&name));
        assert_eq!(name, claim_name("ns", "pool", &request));
        assert_ne!(name, claim_name("ns", "other", &request));
        let mut changed_key = request.clone();
        changed_key.idempotency_key = "another-key".into();
        assert_eq!(name, claim_name("ns", "pool", &changed_key));
        changed_key.attempt_id = "another-attempt".into();
        assert_ne!(name, claim_name("ns", "pool", &changed_key));
        assert!(!dns_name("../unsafe"));
    }

    #[tokio::test]
    async fn claim_contract_prevents_duplicate_attempt_and_retains_tombstone() {
        let request = request();
        let (backend, state, server) = mock_backend(&request).await;
        let lease = backend.acquire(request.clone()).await.unwrap();
        assert_eq!(lease.phase, LeasePhase::Starting);
        assert_eq!(lease.fencing_token.as_deref(), Some("uid-1"));
        assert_eq!(
            backend.acquire(request.clone()).await.unwrap().lease_id,
            lease.lease_id
        );
        assert_eq!(state.lock().unwrap().creates, 1);
        let mut changed_key = request.clone();
        changed_key.idempotency_key = "another-key".into();
        assert_eq!(
            backend.acquire(changed_key).await.unwrap_err().kind,
            ErrorKind::Conflict
        );
        backend.release(&lease).await.unwrap();
        let saved = state.lock().unwrap().claim.clone().unwrap();
        assert_eq!(saved["metadata"]["labels"][MANAGED], "true");
        assert_eq!(saved["metadata"]["labels"][POOL_LABEL], "pool");
        assert!(KubernetesBackend::release_requested(&saved));
        assert_eq!(
            backend.acquire(request).await.unwrap_err().kind,
            ErrorKind::Conflict
        );
        assert_eq!(
            backend.inspect(&lease).await.unwrap().lease.phase,
            LeasePhase::Releasing
        );
        server.abort();
    }

    #[tokio::test]
    async fn timed_out_create_stays_unknown_until_claim_is_reconciled() {
        let request = request();
        let (mut backend, state, server) = mock_backend(&request).await;
        state.lock().unwrap().create_response_delay_ms = 150;
        backend.client = reqwest::Client::builder()
            .timeout(Duration::from_millis(50))
            .build()
            .unwrap();
        let unknown = backend.acquire(request.clone()).await.unwrap();
        assert_eq!(unknown.phase, LeasePhase::Unknown);
        assert!(unknown.fencing_token.is_none());
        assert_eq!(state.lock().unwrap().creates, 1);
        let observed = backend.inspect(&unknown).await.unwrap();
        assert_eq!(observed.lease.fencing_token.as_deref(), Some("uid-1"));
        assert_eq!(
            backend.acquire(request).await.unwrap().lease_id,
            unknown.lease_id
        );
        assert_eq!(state.lock().unwrap().creates, 1);
        server.abort();
    }

    #[tokio::test]
    async fn concurrent_claim_requests_allocate_once() {
        let request = request();
        let (backend, state, server) = mock_backend(&request).await;
        let backend = Arc::new(backend);
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..16 {
            let backend = backend.clone();
            let request = request.clone();
            tasks.spawn(async move { backend.acquire(request).await });
        }
        while let Some(result) = tasks.join_next().await {
            let lease = result.unwrap().unwrap();
            assert_eq!(lease.fencing_token.as_deref(), Some("uid-1"));
        }
        assert_eq!(state.lock().unwrap().creates, 1);
        server.abort();
    }

    #[tokio::test]
    async fn stale_uid_or_missing_claim_never_releases_a_replacement() {
        let request = request();
        let (backend, state, server) = mock_backend(&request).await;
        let lease = backend.acquire(request.clone()).await.unwrap();
        {
            let mut state = state.lock().unwrap();
            state.claim.as_mut().unwrap()["metadata"]["uid"] = json!("replacement-uid");
        }
        assert_eq!(
            backend.release(&lease).await.unwrap_err().kind,
            ErrorKind::Conflict
        );
        assert!(!KubernetesBackend::release_requested(
            state.lock().unwrap().claim.as_ref().unwrap()
        ));
        state.lock().unwrap().claim = None;
        assert_eq!(
            backend.inspect(&lease).await.unwrap().lease.phase,
            LeasePhase::Missing
        );
        assert_eq!(
            backend.release(&lease).await.unwrap_err().kind,
            ErrorKind::Unknown
        );
        let unknown = backend.initial_lease(request).unwrap();
        assert_eq!(
            backend.inspect(&unknown).await.unwrap().lease.phase,
            LeasePhase::Unknown
        );
        assert_eq!(
            backend.release(&unknown).await.unwrap_err().kind,
            ErrorKind::Unknown
        );
        assert_eq!(state.lock().unwrap().creates, 1);
        server.abort();
    }
}
