// Task prerequisite facts. Passing this report grants no execution permission.
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const providers = {
  openai: { key: "OPENAI_API_KEY", url: "https://api.openai.com/v1/models" },
  deepseek: { key: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com/models" },
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v, minimum = 0) => Number.isSafeInteger(v) && v >= minimum;
export class PreflightError extends Error {
  constructor(code, report = null) {
    super("Task preflight: " + code);
    this.code = code;
    this.report = report;
  }
}
function fields(value, allowed) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new PreflightError("invalid_requirements");
}
export function taskRequirements(input = {}) {
  fields(input, [
    "schema",
    "cli",
    "profile",
    "min_free_bytes",
    "port",
    "wsl",
    "gpu",
    "auth",
    "required_files",
  ]);
  if (input.schema !== undefined && input.schema !== 1)
    throw new PreflightError("invalid_requirements");
  const result = {
    schema: 1,
    cli: input.cli ?? null,
    profile: input.profile ?? "acp",
    min_free_bytes: input.min_free_bytes ?? 0,
    port: input.port ?? null,
    wsl: input.wsl ?? null,
    gpu: input.gpu ?? null,
    auth: input.auth ?? null,
    required_files: input.required_files ?? [],
  };
  if (
    ![null, "dsh", "codex", "claude", "kimi"].includes(result.cli) ||
    typeof result.profile !== "string" ||
    !integer(result.min_free_bytes) ||
    (result.port !== null && (!integer(result.port, 1) || result.port > 65535))
  )
    throw new PreflightError("invalid_requirements");
  if (result.wsl !== null) {
    fields(result.wsl, ["distribution"]);
    if (
      typeof result.wsl.distribution !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(result.wsl.distribution)
    )
      throw new PreflightError("invalid_requirements");
  }
  if (result.gpu !== null) {
    fields(result.gpu, ["min_free_mib"]);
    if (!integer(result.gpu.min_free_mib))
      throw new PreflightError("invalid_requirements");
  }
  if (result.auth !== null) {
    fields(result.auth, ["provider"]);
    if (!Object.hasOwn(providers, result.auth.provider))
      throw new PreflightError("unsupported_auth_provider");
  }
  if (
    !Array.isArray(result.required_files) ||
    result.required_files.length > 32 ||
    result.required_files.some(
      (file) =>
        typeof file !== "string" ||
        !file ||
        file.length > 2000 ||
        file.includes("\0") ||
        path.isAbsolute(file) ||
        file.split(/[\\/]/).includes(".."),
    )
  )
    throw new PreflightError("invalid_requirements");
  return structuredClone(result);
}
async function freePort(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
async function authRequest(provider, credential, fetcher) {
  try {
    const response = await fetcher(provider.url, {
      method: "GET",
      headers: { authorization: "Bearer " + credential },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      return { reason: "authentication_rejected", verified: false };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { reason: "authentication_unverified", verified: false };
    }
    const reader = response.body?.getReader();
    if (!reader)
      return { reason: "authentication_response_invalid", verified: false };
    let size = 0,
      chunks = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          return { reason: "authentication_response_invalid", verified: false };
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    return object(body) &&
      body.object === "list" &&
      Array.isArray(body.data) &&
      body.data.every((model) => object(model) && typeof model.id === "string")
      ? { reason: "models_read_verified", verified: true }
      : { reason: "authentication_response_invalid", verified: false };
  } catch {
    return { reason: "authentication_transport_failed", verified: false };
  }
}

export async function preflightTask(
  {
    requirements = {},
    cwd = process.cwd(),
    command = null,
    env = process.env,
    verifyAuth = false,
  } = {},
  probes = {},
) {
  const required = taskRequirements(requirements);
  env = { ...env };
  if (Array.isArray(command)) command = [...command];
  const checks = [];
  const add = (id, status, stage, reason, fix = null, details = {}) =>
    checks.push({
      id,
      status,
      stage,
      reason,
      fix,
      observed_at: new Date().toISOString(),
      ...details,
    });
  const skip = (id) => add(id, "not_required", null, "not_required");
  const node = (probes.nodeVersion || process.versions.node)
    .split(".")
    .map(Number);
  const nodeOk =
    node.length >= 3 && node.every(Number.isInteger) && node[0] >= 22;
  add(
    "node",
    nodeOk ? "pass" : "blocked",
    "configuration",
    nodeOk ? "node_version_supported" : "node_version_unsupported",
    nodeOk ? null : "Node 22以上を選択してください。",
  );
  let root = null;
  try {
    root = await fs.realpath(path.resolve(cwd));
    if (!(await fs.stat(root)).isDirectory()) root = null;
  } catch {
    /* Static diagnostics only; filesystem errors can contain private paths. */
  }
  add(
    "cwd",
    root ? "pass" : "blocked",
    "existence",
    root ? "directory_exists" : "cwd_unavailable",
    root ? null : "対象projectの存在するdirectoryを指定してください。",
  );
  if (!required.cli) {
    skip("cli");
    skip("profile");
  } else {
    const profileOk = required.cli === "dsh" && required.profile === "acp";
    add(
      "profile",
      profileOk ? "pass" : "blocked",
      "configuration",
      profileOk ? "adapter_profile_selected" : "unsupported_profile",
      profileOk ? null : "対応済みのDSH ACP profileを選択してください。",
    );
    if (!nodeOk || !root || !profileOk)
      add(
        "cli",
        "blocked",
        "configuration",
        "prerequisite_blocked",
        "先にNode・cwd・profileの失敗項目を直してください。",
      );
    else {
      try {
        const create =
          probes.adapterFactory ||
          (await import("./adapters.mjs")).createCliAdapter;
        const adapter = create({ cli: required.cli, command, cwd: root, env });
        const report = await adapter.probe();
        const matched = ["version_matched", "compatible"].includes(
          report.health,
        );
        add(
          "cli",
          matched ? "pass" : "blocked",
          "configuration",
          matched ? "cli_version_matched" : "cli_unavailable_or_incompatible",
          matched
            ? null
            : "original DSHの実体と対応版を指定してください。rdsh doctorでwrapperの重なりも確認できます。",
          {
            detected_version: matched ? report.detected_version : null,
            protocol_checked: false,
          },
        );
      } catch {
        add(
          "cli",
          "blocked",
          "existence",
          "adapter_dependency_unavailable",
          "dashboardでnpm ciを実行し、original DSHのpathを確認してください。",
        );
      }
    }
  }
  if (!required.min_free_bytes) skip("disk");
  else if (!root)
    add(
      "disk",
      "blocked",
      "existence",
      "cwd_unavailable",
      "先にcwdを直してください。",
    );
  else {
    try {
      const value = await (probes.statfs || fs.statfs)(root, { bigint: true });
      const free = BigInt(value.bavail) * BigInt(value.bsize);
      const sufficient = free >= BigInt(required.min_free_bytes);
      add(
        "disk",
        sufficient ? "pass" : "blocked",
        "existence",
        sufficient ? "disk_space_available" : "insufficient_disk_space",
        sufficient
          ? null
          : "対象driveの空き容量を確認し、必要量を確保してください。",
        {
          free_bytes: free.toString(),
          required_bytes: required.min_free_bytes,
        },
      );
    } catch {
      add(
        "disk",
        "blocked",
        "existence",
        "disk_space_unknown",
        "対象driveで容量を取得できることを確認してください。",
      );
    }
  }
  if (!required.port) skip("port");
  else {
    let available = false;
    try {
      available = await (probes.portAvailable || freePort)(required.port);
    } catch {}
    add(
      "port",
      available ? "pass" : "blocked",
      "existence",
      available ? "loopback_port_available" : "port_unavailable",
      available
        ? null
        : "指定portを使用中のサービスと、今回のport設定を確認してください。",
      { port: required.port, reservation: false },
    );
  }
  if (!required.required_files.length) skip("dependencies");
  else {
    let missing = 0;
    for (const file of required.required_files) {
      try {
        if (!root) throw new Error();
        const candidate = path.resolve(root, file);
        const lexical = path.relative(root, candidate);
        if (
          lexical === ".." ||
          lexical.startsWith(".." + path.sep) ||
          path.isAbsolute(lexical)
        )
          throw new Error();
        const actual = await fs.realpath(candidate);
        const relative = path.relative(root, actual);
        if (
          relative === ".." ||
          relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative) ||
          !(await fs.stat(actual)).isFile()
        )
          throw new Error();
      } catch {
        missing++;
      }
    }
    add(
      "dependencies",
      missing ? "blocked" : "pass",
      "existence",
      missing ? "required_files_missing" : "required_files_exist",
      missing
        ? "taskで指定したproject内の依存ファイルを揃えてください。"
        : null,
      { missing_count: missing },
    );
  }
  const platform = probes.platform || process.platform;
  const query = probes.exec || exec;
  if (!required.wsl) skip("wsl");
  else if (platform !== "win32")
    add(
      "wsl",
      "blocked",
      "existence",
      "wsl_requires_windows",
      "WSLが必要なtaskは対応するWindows環境で開始してください。",
    );
  else {
    try {
      await query(
        "wsl.exe",
        ["-d", required.wsl.distribution, "--exec", "/bin/true"],
        {
          env,
          windowsHide: true,
          shell: false,
          timeout: 15000,
          maxBuffer: 4096,
        },
      );
      add("wsl", "pass", "communication", "selected_wsl_responded");
    } catch {
      add(
        "wsl",
        "blocked",
        "communication",
        "selected_wsl_unavailable",
        "指定distributionの存在と起動状態を確認してください。",
      );
    }
  }
  if (!required.gpu) skip("gpu");
  else {
    const visibility = env.CUDA_VISIBLE_DEVICES ?? env.NVIDIA_VISIBLE_DEVICES;
    if (
      visibility !== undefined &&
      ["", "-1", "none", "void"].includes(visibility.toLowerCase())
    )
      add(
        "gpu",
        "blocked",
        "configuration",
        "gpu_hidden_by_environment",
        "taskのGPU公開範囲を確認してください。",
      );
    else {
      try {
        const args = ["--query-gpu=memory.free", "--format=csv,noheader"];
        if (visibility !== undefined && visibility !== "all") {
          if (!/^[a-zA-Z0-9_,.-]+$/.test(visibility)) throw new Error();
          args.push("--id=" + visibility);
        }
        const output = await query("nvidia-smi", args, {
          env,
          windowsHide: true,
          shell: false,
          timeout: 5000,
          maxBuffer: 4096,
        });
        const lines = output.stdout.trim().split(/\r?\n/);
        const memory = lines.map((line) => {
          const match = /^(\d+)\s+MiB$/.exec(line.trim());
          if (!match) throw new Error();
          return Number(match[1]);
        });
        if (!memory.length || memory.some((value) => !integer(value)))
          throw new Error();
        const enough = memory.some(
          (value) => value >= required.gpu.min_free_mib,
        );
        add(
          "gpu",
          enough ? "pass" : "blocked",
          "communication",
          enough ? "gpu_inventory_observed" : "insufficient_gpu_memory",
          enough
            ? null
            : "対象GPUの空きmemoryとtaskの必要量を確認してください。",
          {
            max_free_mib: Math.max(...memory),
            scope: "NVIDIA driver inventory; workload compatibility unverified",
          },
        );
      } catch {
        add(
          "gpu",
          "blocked",
          "communication",
          "gpu_inventory_unavailable",
          "必要なNVIDIA driverとGPU公開範囲を確認してください。",
        );
      }
    }
  }
  if (!required.auth) skip("auth");
  else {
    const provider = providers[required.auth.provider];
    const credential = env[provider.key];
    const present = typeof credential === "string" && credential.length > 0;
    if (!present)
      add(
        "auth",
        "blocked",
        "existence",
        "credential_not_observed",
        "選択providerのAPI key設定を確認してください。OAuth接続は専用の検証経路が必要です。",
        { credential_presence: "not_observed", verified: false },
      );
    else if (
      credential.length > 8192 ||
      credential !== credential.trim() ||
      /[\x00-\x20\x7f]/.test(credential)
    )
      add(
        "auth",
        "blocked",
        "configuration",
        "credential_configuration_invalid",
        "選択providerのAPI key設定を修正してください。",
        { credential_presence: "present", verified: false },
      );
    else if (!verifyAuth)
      add(
        "auth",
        "blocked",
        "configuration",
        "authentication_unverified",
        "--verify-authを明示すると選択providerのmodels APIだけに疎通検査します。",
        {
          credential_presence: "present",
          verified: false,
          additional_communication: "GET " + provider.url,
        },
      );
    else if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      add(
        "auth",
        "blocked",
        "configuration",
        "insecure_auth_transport",
        "認証検査前にTLS検証を有効にしてください。",
        { credential_presence: "present", verified: false },
      );
    else {
      const verified = await authRequest(
        provider,
        credential,
        probes.fetch || fetch,
      );
      add(
        "auth",
        verified.verified ? "pass" : "blocked",
        "communication",
        verified.reason,
        verified.verified
          ? null
          : "選択providerのAPI keyと通信状態を確認してください。",
        {
          credential_presence: "present",
          verified: verified.verified,
          verification_scope: "models_read_only",
          endpoint: provider.url,
          model_request: false,
        },
      );
    }
  }
  return {
    schema: 1,
    ready: checks.every((check) => check.status !== "blocked"),
    observed_at: new Date().toISOString(),
    checks,
    execution_authority: false,
    automatic_repairs: false,
  };
}
export function requireReady(report) {
  if (!report.ready) throw new PreflightError("blocked", report);
}
export async function readRequirements(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    if ((await handle.stat()).size > 65536)
      throw new PreflightError("requirements_too_large");
    return taskRequirements(JSON.parse(await handle.readFile("utf8")));
  } catch {
    throw new PreflightError("invalid_requirements");
  } finally {
    await handle?.close();
  }
}
export async function preflightCli(args = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        project: { type: "string" },
        requirements: { type: "string" },
        executable: { type: "string" },
        entrypoint: { type: "string" },
        "verify-auth": { type: "boolean" },
      },
    });
    if (positionals.length || (values.entrypoint && !values.executable))
      throw new PreflightError("invalid_arguments");
    const requirements = values.requirements
      ? await readRequirements(values.requirements)
      : {};
    const command = values.executable
      ? [values.executable, ...(values.entrypoint ? [values.entrypoint] : [])]
      : null;
    const report = await preflightTask({
      requirements,
      command,
      cwd: values.project || process.cwd(),
      verifyAuth: values["verify-auth"] || false,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } catch {
    console.log(
      JSON.stringify({
        ready: false,
        error: "invalid_preflight_input",
        execution_authority: false,
      }),
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await preflightCli();
