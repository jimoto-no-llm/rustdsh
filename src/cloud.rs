//! Opt-in cloud execution boundary. This module never runs the DSH agent loop.

mod fake;
mod kubernetes;

use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

pub type CloudFuture<'a, T> = Pin<Box<dyn Future<Output = CloudResult<T>> + Send + 'a>>;
pub type CloudResult<T> = Result<T, CloudError>;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Invalid,
    Unavailable,
    Conflict,
    Unknown,
    NotFound,
    Forbidden,
    Execution,
}

#[derive(Debug)]
pub struct CloudError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CloudError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl std::error::Error for CloudError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxRequest {
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub worker_id: String,
    pub idempotency_key: String,
    pub container_name: String,
    pub image_digest: String,
}

impl SandboxRequest {
    pub fn validate(&self) -> CloudResult<()> {
        for (name, value, max) in [
            ("run_id", &self.run_id, 128),
            ("task_id", &self.task_id, 128),
            ("attempt_id", &self.attempt_id, 128),
            ("worker_id", &self.worker_id, 128),
            ("idempotency_key", &self.idempotency_key, 256),
            ("container_name", &self.container_name, 63),
        ] {
            if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
                return Err(CloudError::new(
                    ErrorKind::Invalid,
                    format!("invalid {name}"),
                ));
            }
        }
        if !valid_image_digest(&self.image_digest) {
            return Err(CloudError::new(
                ErrorKind::Invalid,
                "image_digest must pin a sha256 image",
            ));
        }
        Ok(())
    }
}

fn valid_image_digest(image: &str) -> bool {
    image.split_once("@sha256:").is_some_and(|(name, digest)| {
        !name.is_empty()
            && !name.contains('@')
            && digest.len() == 64
            && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LeasePhase {
    Unknown,
    Starting,
    Ready,
    Releasing,
    Missing,
    Released,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AllocationKind {
    Unknown,
    Warm,
    Cold,
    Fake,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxLease {
    pub namespace: String,
    pub pool: String,
    pub request: SandboxRequest,
    pub sandbox_id: String,
    pub lease_id: String,
    pub generation: u64,
    pub fencing_token: Option<String>,
    pub phase: LeasePhase,
    pub allocation: AllocationKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxStatus {
    pub lease: SandboxLease,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capacity {
    pub queued_tasks: Option<u64>,
    pub starting_sandboxes: u64,
    pub running_sandboxes: u64,
    pub warm_pool_available: u64,
    pub desired_warm_pool: u64,
    pub llm_inflight: Option<u64>,
    pub api_rate_limited: Option<u64>,
    pub failed_allocations: Option<u64>,
    pub unknown_allocations: Option<u64>,
    pub orphan_sandboxes: Option<u64>,
    pub cpu_requested_millis: Option<u64>,
    pub cpu_used_millis: Option<u64>,
    pub memory_requested_bytes: Option<u64>,
    pub memory_used_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub argv: Vec<String>,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

pub trait CloudBackend: Send + Sync {
    fn capacity(&self) -> CloudFuture<'_, Capacity>;
    fn acquire(&self, request: SandboxRequest) -> CloudFuture<'_, SandboxLease>;
    fn inspect<'a>(&'a self, lease: &'a SandboxLease) -> CloudFuture<'a, SandboxStatus>;
    fn execute<'a>(
        &'a self,
        lease: &'a SandboxLease,
        command: ExecRequest,
    ) -> CloudFuture<'a, ExecResult>;
    fn release<'a>(&'a self, lease: &'a SandboxLease) -> CloudFuture<'a, ()>;
}

#[derive(ValueEnum, Debug, Clone, Copy)]
pub enum BackendKind {
    Kubernetes,
    Fake,
}

#[derive(Args, Debug)]
pub struct CloudOptions {
    #[arg(long, value_enum, default_value_t = BackendKind::Kubernetes)]
    backend: BackendKind,
    #[arg(long, env = "RDSH_CLOUD_NAMESPACE", default_value = "default")]
    namespace: String,
    #[arg(long, env = "RDSH_CLOUD_POOL")]
    pool: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum PoolAction {
    Plan {
        #[arg(long)]
        template: String,
        #[arg(long)]
        replicas: u32,
    },
    Apply {
        #[arg(long)]
        plan_file: PathBuf,
    },
}

#[derive(Subcommand, Debug)]
pub enum CloudAction {
    Doctor,
    Capacity,
    Pool {
        #[command(subcommand)]
        action: PoolAction,
    },
    Acquire {
        #[arg(long)]
        request_file: PathBuf,
    },
    Exec {
        #[arg(long)]
        lease_file: PathBuf,
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
    Inspect {
        #[arg(long)]
        lease_file: PathBuf,
    },
    Release {
        #[arg(long)]
        lease_file: PathBuf,
    },
    Reconcile {
        #[arg(long)]
        lease_file: PathBuf,
    },
    /// In-memory control-plane test; does not create billable sandboxes.
    LoadTest {
        #[arg(long, default_value_t = 10_000, value_parser = clap::value_parser!(u32).range(1..=100_000))]
        jobs: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolPlan {
    pub namespace: String,
    pub name: String,
    pub template: String,
    pub replicas: u32,
    pub expected_resource_version: Option<String>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> anyhow::Result<T> {
    let bytes = std::fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn print_json<T: Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub fn run(options: CloudOptions, action: CloudAction) -> anyhow::Result<i32> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run_async(options, action))
}

async fn run_async(options: CloudOptions, action: CloudAction) -> anyhow::Result<i32> {
    if let CloudAction::LoadTest { jobs } = action {
        print_json(&fake::load_test(jobs).await?)?;
        return Ok(0);
    }
    if matches!(options.backend, BackendKind::Fake) {
        if matches!(action, CloudAction::Doctor) {
            print_json(&serde_json::json!({"backend":"fake","available":true,"persistent":false}))?;
            return Ok(0);
        }
        anyhow::bail!(
            "fake backend はプロセス内だけで保持します。CLI では load-test を使用してください"
        );
    }
    let backend = kubernetes::KubernetesBackend::from_service_account(
        options.namespace.clone(),
        options.pool.clone(),
    )?;
    match action {
        CloudAction::Doctor => print_json(&backend.doctor().await?),
        CloudAction::Capacity => print_json(&backend.capacity().await?),
        CloudAction::Pool { action } => match action {
            PoolAction::Plan { template, replicas } => {
                let name = options
                    .pool
                    .ok_or_else(|| anyhow::anyhow!("--pool が必要です"))?;
                let plan = backend.pool_plan(name, template, replicas).await?;
                print_json(&plan)
            }
            PoolAction::Apply { plan_file } => {
                let plan: PoolPlan = read_json(&plan_file)?;
                print_json(&backend.apply_pool_plan(plan).await?)
            }
        },
        CloudAction::Acquire { request_file } => {
            let request: SandboxRequest = read_json(&request_file)?;
            print_json(&backend.acquire(request).await?)
        }
        CloudAction::Inspect { lease_file } | CloudAction::Reconcile { lease_file } => {
            let lease: SandboxLease = read_json(&lease_file)?;
            print_json(&backend.inspect(&lease).await?)
        }
        CloudAction::Exec {
            lease_file,
            command,
        } => {
            let lease: SandboxLease = read_json(&lease_file)?;
            let result = backend
                .execute(
                    &lease,
                    ExecRequest {
                        argv: command,
                        timeout_seconds: 600,
                    },
                )
                .await?;
            print_json(&result)?;
            return Ok(if result.exit_code < 0 {
                1
            } else {
                result.exit_code
            });
        }
        CloudAction::Release { lease_file } => {
            let lease: SandboxLease = read_json(&lease_file)?;
            backend.release(&lease).await?;
            print_json(&serde_json::json!({"release_requested":true,"lease_id":lease.lease_id}))
        }
        CloudAction::LoadTest { .. } => unreachable!(),
    }?;
    Ok(0)
}
