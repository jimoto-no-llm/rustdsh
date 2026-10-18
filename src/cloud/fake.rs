use super::*;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Default)]
struct FakeState {
    leases: HashMap<String, SandboxLease>,
    attempts: HashMap<(String, String, String), String>,
    next_generation: u64,
    active: usize,
    unknown_once: bool,
}

pub struct FakeBackend {
    limit: usize,
    state: Mutex<FakeState>,
}

impl FakeBackend {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            state: Mutex::new(FakeState::default()),
        }
    }

    #[cfg(test)]
    fn timeout_next_acquire(&self) {
        self.state.lock().unwrap().unknown_once = true;
    }
}

impl CloudBackend for FakeBackend {
    fn capacity(&self) -> CloudFuture<'_, Capacity> {
        Box::pin(async move {
            let state = self.state.lock().unwrap();
            let running = state
                .leases
                .values()
                .filter(|lease| lease.phase == LeasePhase::Ready)
                .count() as u64;
            let unknown = state
                .leases
                .values()
                .filter(|lease| lease.phase == LeasePhase::Unknown)
                .count() as u64;
            Ok(Capacity {
                queued_tasks: Some(0),
                starting_sandboxes: unknown,
                running_sandboxes: running,
                warm_pool_available: 0,
                desired_warm_pool: 0,
                llm_inflight: None,
                api_rate_limited: Some(0),
                failed_allocations: Some(0),
                unknown_allocations: Some(unknown),
                orphan_sandboxes: Some(0),
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
            let mut state = self.state.lock().unwrap();
            if let Some(lease) = state.leases.get(&request.idempotency_key) {
                if lease.request == request {
                    if lease.phase == LeasePhase::Released {
                        return Err(CloudError::new(
                            ErrorKind::Conflict,
                            "attempt was already released",
                        ));
                    }
                    return Ok(lease.clone());
                }
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "idempotency key is owned by another request",
                ));
            }
            let attempt = (
                request.run_id.clone(),
                request.task_id.clone(),
                request.attempt_id.clone(),
            );
            if state.attempts.contains_key(&attempt) {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "attempt already owns a sandbox",
                ));
            }
            if state.active >= self.limit {
                return Err(CloudError::new(
                    ErrorKind::Unavailable,
                    "sandbox capacity exhausted",
                ));
            }
            state.next_generation += 1;
            let generation = state.next_generation;
            let phase = if state.unknown_once {
                LeasePhase::Unknown
            } else {
                LeasePhase::Ready
            };
            state.unknown_once = false;
            let lease = SandboxLease {
                namespace: "fake".into(),
                pool: "fake".into(),
                request: request.clone(),
                sandbox_id: format!("fake-sandbox-{generation}"),
                lease_id: format!("fake-lease-{generation}"),
                generation,
                fencing_token: Some(format!("fake-uid-{generation}")),
                phase,
                allocation: AllocationKind::Fake,
            };
            state
                .attempts
                .insert(attempt, request.idempotency_key.clone());
            state
                .leases
                .insert(request.idempotency_key.clone(), lease.clone());
            state.active += 1;
            Ok(lease)
        })
    }

    fn inspect<'a>(&'a self, lease: &'a SandboxLease) -> CloudFuture<'a, SandboxStatus> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            let stored = state
                .leases
                .get_mut(&lease.request.idempotency_key)
                .ok_or_else(|| CloudError::new(ErrorKind::NotFound, "lease not found"))?;
            if stored.request != lease.request
                || stored.lease_id != lease.lease_id
                || stored.fencing_token != lease.fencing_token
            {
                return Err(CloudError::new(
                    ErrorKind::Conflict,
                    "lease ownership mismatch",
                ));
            }
            if stored.phase == LeasePhase::Unknown {
                stored.phase = LeasePhase::Ready;
            }
            Ok(SandboxStatus {
                lease: stored.clone(),
                reason: "fake_observation".into(),
            })
        })
    }

    fn execute<'a>(
        &'a self,
        lease: &'a SandboxLease,
        command: ExecRequest,
    ) -> CloudFuture<'a, ExecResult> {
        Box::pin(async move {
            let observed = self.inspect(lease).await?;
            if observed.lease.phase != LeasePhase::Ready {
                return Err(CloudError::new(ErrorKind::Conflict, "sandbox is not ready"));
            }
            if command.argv.is_empty() {
                return Err(CloudError::new(ErrorKind::Invalid, "empty argv"));
            }
            Ok(ExecResult {
                exit_code: 0,
                stdout: command.argv.join(" "),
                stderr: String::new(),
                truncated: false,
            })
        })
    }

    fn release<'a>(&'a self, lease: &'a SandboxLease) -> CloudFuture<'a, ()> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            let was_active = {
                let stored = state
                    .leases
                    .get_mut(&lease.request.idempotency_key)
                    .ok_or_else(|| CloudError::new(ErrorKind::NotFound, "lease not found"))?;
                if stored.request != lease.request
                    || stored.lease_id != lease.lease_id
                    || stored.fencing_token != lease.fencing_token
                {
                    return Err(CloudError::new(
                        ErrorKind::Conflict,
                        "lease ownership mismatch",
                    ));
                }
                if stored.phase == LeasePhase::Unknown {
                    return Err(CloudError::new(
                        ErrorKind::Unknown,
                        "unknown allocation must be reconciled before release",
                    ));
                }
                let was_active = stored.phase != LeasePhase::Released;
                stored.phase = LeasePhase::Released;
                was_active
            };
            if was_active {
                state.active -= 1;
            }
            Ok(())
        })
    }
}

#[derive(Serialize)]
pub struct LoadReport {
    backend: &'static str,
    jobs: u32,
    simultaneous_leases: u64,
    elapsed_ms: u128,
    acquire_latency_p50_us: u128,
    acquire_latency_p95_us: u128,
    acquire_latency_p99_us: u128,
    executed: u32,
    released: u32,
    remaining_sandboxes: u64,
}

pub async fn load_test(jobs: u32) -> CloudResult<LoadReport> {
    if !(1..=100_000).contains(&jobs) {
        return Err(CloudError::new(
            ErrorKind::Invalid,
            "jobs must be in 1..=100000",
        ));
    }
    let backend = FakeBackend::new(jobs as usize);
    let started = Instant::now();
    let mut times = Vec::with_capacity(jobs as usize);
    let mut leases = Vec::with_capacity(jobs as usize);
    for n in 0..jobs {
        let request = SandboxRequest {
            run_id: "fake-load-run".into(),
            task_id: format!("task-{n}"),
            attempt_id: "attempt-1".into(),
            worker_id: format!("worker-{n}"),
            idempotency_key: format!("fake-load-{n}"),
            container_name: "worker".into(),
            image_digest: format!("example.invalid/rdsh@sha256:{}", "0".repeat(64)),
        };
        let acquire_started = Instant::now();
        leases.push(backend.acquire(request).await?);
        times.push(acquire_started.elapsed().as_micros());
    }
    let simultaneous_leases = backend.capacity().await?.running_sandboxes;
    if simultaneous_leases != u64::from(jobs) {
        return Err(CloudError::new(
            ErrorKind::Execution,
            "fake lease count mismatch",
        ));
    }
    for lease in &leases {
        let result = backend
            .execute(
                lease,
                ExecRequest {
                    argv: vec![lease.request.task_id.clone()],
                    timeout_seconds: 1,
                },
            )
            .await?;
        if result.exit_code != 0 || result.stdout != lease.request.task_id || result.truncated {
            return Err(CloudError::new(
                ErrorKind::Execution,
                "fake result identity mismatch",
            ));
        }
        backend.release(lease).await?;
    }
    let remaining_sandboxes = backend.capacity().await?.running_sandboxes;
    if remaining_sandboxes != 0 {
        return Err(CloudError::new(
            ErrorKind::Execution,
            "fake leases remain after release",
        ));
    }
    times.sort_unstable();
    let percentile = |p: usize| times[((jobs as usize - 1) * p) / 100];
    Ok(LoadReport {
        backend: "fake",
        jobs,
        simultaneous_leases,
        elapsed_ms: started.elapsed().as_millis(),
        acquire_latency_p50_us: percentile(50),
        acquire_latency_p95_us: percentile(95),
        acquire_latency_p99_us: percentile(99),
        executed: jobs,
        released: jobs,
        remaining_sandboxes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(key: &str) -> SandboxRequest {
        SandboxRequest {
            run_id: "r".into(),
            task_id: "t".into(),
            attempt_id: "a".into(),
            worker_id: "w".into(),
            idempotency_key: key.into(),
            container_name: "worker".into(),
            image_digest: format!("x@sha256:{}", "0".repeat(64)),
        }
    }

    #[tokio::test]
    async fn attempt_is_idempotent_and_cannot_be_reassigned() {
        let backend = FakeBackend::new(2);
        let first = backend.acquire(request("key-1")).await.unwrap();
        assert_eq!(first, backend.acquire(request("key-1")).await.unwrap());
        assert_eq!(
            backend.acquire(request("key-2")).await.unwrap_err().kind,
            ErrorKind::Conflict
        );
        backend.release(&first).await.unwrap();
        assert_eq!(
            backend.acquire(request("key-1")).await.unwrap_err().kind,
            ErrorKind::Conflict
        );
        assert_eq!(
            backend.acquire(request("key-2")).await.unwrap_err().kind,
            ErrorKind::Conflict
        );
    }

    #[tokio::test]
    async fn unknown_requires_reconciliation_before_release() {
        let backend = FakeBackend::new(1);
        backend.timeout_next_acquire();
        let lease = backend.acquire(request("key")).await.unwrap();
        assert_eq!(lease.phase, LeasePhase::Unknown);
        assert_eq!(
            backend.release(&lease).await.unwrap_err().kind,
            ErrorKind::Unknown
        );
        let observed = backend.inspect(&lease).await.unwrap();
        assert_eq!(observed.lease.phase, LeasePhase::Ready);
        backend.release(&observed.lease).await.unwrap();
    }

    #[tokio::test]
    async fn ten_thousand_control_leases() {
        let report = load_test(10_000).await.unwrap();
        assert_eq!(report.simultaneous_leases, 10_000);
        assert_eq!(report.executed, 10_000);
        assert_eq!(report.released, 10_000);
        assert_eq!(report.remaining_sandboxes, 0);
    }

    #[tokio::test]
    async fn rejected_owner_and_repeated_release_leave_other_worker_alive() {
        let backend = FakeBackend::new(2);
        let first = backend.acquire(request("key-1")).await.unwrap();
        let mut second_request = request("key-2");
        second_request.task_id = "other-task".into();
        let second = backend.acquire(second_request).await.unwrap();
        let mut wrong_owner = first.clone();
        wrong_owner.fencing_token = second.fencing_token.clone();
        assert_eq!(
            backend.release(&wrong_owner).await.unwrap_err().kind,
            ErrorKind::Conflict
        );
        assert_eq!(backend.capacity().await.unwrap().running_sandboxes, 2);
        backend.release(&first).await.unwrap();
        backend.release(&first).await.unwrap();
        assert_eq!(backend.capacity().await.unwrap().running_sandboxes, 1);
        assert_eq!(
            backend.inspect(&second).await.unwrap().lease.phase,
            LeasePhase::Ready
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_acquires_share_one_attempt() {
        let backend = std::sync::Arc::new(FakeBackend::new(1));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..32 {
            let backend = backend.clone();
            tasks.spawn(async move { backend.acquire(request("key")).await });
        }
        let mut ids = std::collections::HashSet::new();
        while let Some(result) = tasks.join_next().await {
            ids.insert(result.unwrap().unwrap().lease_id);
        }
        assert_eq!(ids.len(), 1);
        assert_eq!(backend.capacity().await.unwrap().running_sandboxes, 1);
    }
}
