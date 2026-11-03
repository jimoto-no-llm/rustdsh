// First-run provisioning UI. All operations go through token-protected, fixed
// server actions; no command, path or download URL comes from the browser.
(function () {
  "use strict";
  var state = null, lastRequest = null, poll = 0, busy = false, announcement = "", triedAutomatic = false;
  var panel = el("section", "provision-panel");
  panel.setAttribute("aria-labelledby", "provision-title");
  var heading = el("h2", "", t("自動で準備できます", "Automatic setup", "自动准备"));
  heading.id = "provision-title";
  panel.append(heading, el("p", "small", t("不足している実行環境を、このPCの利用者専用の場所へ準備します。", "Missing tools are installed privately for this user.", "将缺少的组件安装到当前用户的专用目录。")));
  var runtimeButton = el("button", "primary big", t("必要なものを自動で準備", "Prepare everything needed", "自动准备所需组件"));
  runtimeButton.type = "button";
  runtimeButton.onclick = function () { begin({action: "runtime"}); };
  panel.append(runtimeButton);
  $("checks").after(panel);

  var local = el("section", "option local-choice");
  local.setAttribute("aria-labelledby", "local-model-title");
  var localTitle = el("h2", "", t("このPCで使う・アカウント不要", "Run on this computer", "在本机运行，无需账户"));
  localTitle.id = "local-model-title";
  local.append(localTitle, el("p", "small", t("rdsh専用のOllamaとモデルを自動で準備します。既存の設定は変更せず、APIキーも不要です。", "Ollama and the model are prepared automatically. No external API key is needed.", "自动准备 Ollama 和模型，无需外部 API 密钥。")));
  var fieldset = el("fieldset", "model-sizes");
  var legend = el("legend", "small", t("モデルの大きさ", "Model size", "模型大小"));
  fieldset.append(legend);
  [ ["qwen3:1.7b", "1.4 GB", ["軽量", "Light", "轻量"]], ["qwen3:4b", "2.5 GB", ["標準", "Standard", "标准"]], ["qwen3:8b", "5.2 GB", ["大きめ", "Larger", "较大"]] ].forEach(function (choice, index) {
    var label = el("label", "size-option");
    var input = el("input"); input.type = "radio"; input.name = "local-model"; input.value = choice[0]; input.id = "local-model-" + index;
    input.checked = index === 1;
    label.htmlFor = input.id;
    label.append(input, el("strong", "", t.apply(null, choice[2])), el("span", "small", choice[0] + " · " + choice[1]));
    fieldset.append(label);
  });
  local.append(fieldset);
  var localButton = el("button", "primary big", t("このモデルを自動で準備", "Prepare this model", "自动准备此模型"));
  localButton.type = "button";
  localButton.onclick = function () {
    var input = fieldset.querySelector("input:checked");
    if (input) begin({action: "local-model", model: input.value});
  };
  local.append(localButton, el("p", "hint", t("初回はモデルに加え、実行環境もダウンロードします（数百MB〜数GB）。空き容量12GB以上を目安にしてください。", "The first run also downloads the runtime (hundreds of MB to a few GB). Allow at least 12 GB of free space.", "首次还需下载运行环境（数百 MB 至数 GB）。请预留至少 12 GB 可用空间。")));
  $("options").after(local);

  var cloud = el("section", "option cloud-choice");
  cloud.setAttribute("aria-labelledby", "cloud-model-title");
  var cloudTitle = el("h2", "", t("見つかった接続から始める", "Use an existing connection", "使用已有连接")); cloudTitle.id = "cloud-model-title";
  cloud.append(cloudTitle, el("p", "small", t("利用できるモデルを一覧から選びます。おすすめを最初に表示します。", "Choose a known model. A suggested option is selected for you.", "从已知模型中选择，默认显示建议选项。")));
  var cloudLabel = el("label", "small", t("使うモデル", "Model to use", "使用的模型")); cloudLabel.htmlFor = "cloud-model";
  var cloudSelect = el("select"); cloudSelect.id = "cloud-model"; cloudSelect.name = "cloud-model";
  var cloudButton = el("button", "primary big", t("このモデルを使う", "Use this model", "使用此模型")); cloudButton.type = "button";
  cloudButton.onclick = function () { var selected = (state.choices || [])[Number(cloudSelect.value)]; if (selected) begin({action: "select", provider: selected.provider, model: selected.model}); };
  cloud.append(cloudLabel, cloudSelect, cloudButton); cloud.hidden = true;
  local.before(cloud);

  var progressBox = el("section", "provision-progress"); progressBox.hidden = true;
  var progressLabel = el("label", "", ""); progressLabel.htmlFor = "provision-progress";
  var progress = el("progress"); progress.id = "provision-progress"; progress.max = 1;
  var numbers = el("p", "small", "");
  var status = el("p", "small", ""); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  var cancel = el("button", "", t("準備を中止", "Cancel setup", "取消准备")); cancel.type = "button";
  cancel.onclick = async function () { cancel.disabled = true; try { await api("POST", "/api/provision", {action: "cancel"}); status.textContent = t("停止しています…", "Stopping…", "正在停止…"); } catch (_) { cancel.disabled = false; } };
  var retry = el("button", "primary", t("もう一度試す", "Try again", "重试")); retry.type = "button"; retry.hidden = true;
  retry.onclick = function () { if (lastRequest) begin(lastRequest); };
  progressBox.append(progressLabel, progress, numbers, status, cancel, retry);
  // One shared progress region stays visible through step changes.
  document.querySelector("main.card").before(progressBox);

  var phases = {
    cancelling: ["停止しています…", "Stopping…", "正在停止…"],
    preparing: ["準備しています", "Preparing", "正在准备"], runtime: ["実行環境を準備しています", "Preparing runtime", "正在准备运行环境"],
    "ollama-download": ["Ollamaをダウンロードしています", "Downloading Ollama", "正在下载 Ollama"],
    "ollama-extract": ["Ollamaを展開しています", "Extracting Ollama", "正在解压 Ollama"],
    "local-server": ["モデルの実行環境を起動しています", "Starting the local runtime", "正在启动本地运行环境"],
    "model-download": ["モデルをダウンロードしています", "Downloading the model", "正在下载模型"],
    configure: ["最初に使うモデルを設定しています", "Selecting your first model", "正在设置首个模型"],
    complete: ["準備ができました", "Ready", "准备就绪"], failed: ["準備を完了できませんでした", "Setup could not finish", "未能完成准备"]
  };
  var errors = {
    CANCELLED: ["準備を中止しました。いつでも再開できます。", "Setup cancelled. You can retry at any time.", "已取消，可随时重试。"],
    INSUFFICIENT_SPACE: ["空き容量が足りません。12GB以上空けてから再試行してください。", "Not enough space. Free at least 12 GB and retry.", "空间不足，请释放至少 12 GB 后重试。"],
    CHECKSUM_MISMATCH: ["ダウンロードの検証に失敗したため、実行せず停止しました。再試行してください。", "Download verification failed. Nothing was executed. Please retry.", "下载校验失败，已停止执行。请重试。"],
    UNSUPPORTED_HOST: ["このOS・CPUの自動導入には未対応です。既存のAPI接続をご利用ください。", "Automatic installation is unavailable for this OS/CPU. Use an existing API connection.", "暂不支持此系统或 CPU 的自动安装，请使用已有 API 连接。"]
  };
  function bytes(value) { return value >= 1e9 ? (value / 1e9).toFixed(1) + " GB" : Math.round(value / 1e6) + " MB"; }
  function selectedReady() { return !!(state && state.selected && ENV && ENV.dsh && ENV.dsh.found); }
  window.rdshProvisionReady = selectedReady;
  window.rdshPrepareLogin = function () { begin({action:"codex"}); };
  window.rdshProvisionSelection = function () { return state && state.selected; };
  function announce(message) { if (message !== announcement) { announcement = message; status.textContent = message; } }
  function render() {
    if (!state) return;
    var job = state.job || {}, running = !!job.running;
    panel.hidden = !!(ENV && ENV.node && ENV.node.supported && ENV.dsh.found && ENV.pnpm);
    [runtimeButton, localButton, cloudButton, cloudSelect].forEach(function (button) { button.disabled = running || busy; });
    fieldset.disabled = running || busy;
    progressBox.hidden = !running && !job.error && !job.ready;
    progress.hidden = !running;
    progressLabel.textContent = t.apply(null, phases[job.phase] || phases.preparing);
    cancel.hidden = !running; cancel.disabled = job.phase === "cancelling"; retry.hidden = running || !job.error || !lastRequest;
    if (job.total > 0) { progress.max = job.total; progress.value = Math.min(job.completed || 0, job.total); numbers.textContent = bytes(job.completed || 0) + " / " + bytes(job.total); }
    else { progress.removeAttribute("value"); numbers.textContent = running ? t("通信状況によって時間がかかります。この画面のままお待ちください。", "This can take a while. Keep this page open.", "可能需要一些时间，请保持页面打开。") : ""; }
    if (job.error) announce(t.apply(null, errors[job.error] || ["準備に失敗しました。ネット接続を確認し、再試行してください。既存の設定は残っています。", "Setup failed. Check your connection and retry. Existing settings are preserved.", "准备失败，请检查网络后重试。已有设置已保留。"]));
    else announce(progressLabel.textContent);
    if (selectedReady()) {
      $("connect-next").disabled = false; $("connect-skip").hidden = true;
      $("okbar").hidden = false; $("okbar").textContent = "✓ " + state.selected.provider + " / " + state.selected.model;
      $("model-line").textContent = t("使うモデル：", "Model: ", "使用模型：") + state.selected.model;
    }
    $("done").disabled = running;
  }
  function renderChoices() {
    if (!state || !Array.isArray(state.choices)) return;
    var previous = cloudSelect.selectedOptions[0] && cloudSelect.selectedOptions[0].textContent;
    cloudSelect.replaceChildren();
    var choices = state.choices;
    choices.forEach(function (choice, index) { var option = el("option", "", choice.provider + " / " + choice.model); option.value = String(index); cloudSelect.append(option); });
    var best = 0;
    choices.forEach(function (choice, index) {
      if ((choice.provider + " / " + choice.model) === previous || (state.selected && choice.provider === state.selected.provider && choice.model === state.selected.model)) best = index;
    });
    if (!previous && !state.selected) {
      var defaultModel = (STATUS && STATUS.defaults || []).find(function (item) { return item.state === "ok"; });
      var currentDefault = defaultModel ? choices.findIndex(function (choice) { return choice.provider === defaultModel.provider && choice.model === defaultModel.model; }) : -1;
      var subscription = choices.findIndex(function (choice) { return choice.provider === "openai-codex" && /luna|mini/i.test(choice.model); });
      if (subscription < 0) subscription = choices.findIndex(function (choice) { return choice.provider === "openai-codex"; });
      var light = choices.findIndex(function (choice) { return /mini|haiku|flash|small/i.test(choice.model) && !/image|audio|realtime/i.test(choice.model); });
      best = currentDefault >= 0 ? currentDefault : subscription >= 0 ? subscription : light >= 0 ? light : 0;
    }
    cloudSelect.value = String(best); cloud.hidden = !choices.length;
  }
  async function refresh() {
    if (!setupToken || current === "token") return;
    try { state = await api("GET", "/api/provision"); renderChoices(); render(); }
    catch (_) { /* The setup token and main status flow handle authentication. */ }
    if (state && !state.selected && !state.job.running && !state.job.error && !triedAutomatic && STATUS && !STATUS.needed && state.choices.length) {
      triedAutomatic = true;
      var choice = state.choices[Number(cloudSelect.value) || 0];
      await begin({action: "select", provider: choice.provider, model: choice.model});
      return;
    }
    clearTimeout(poll);
    if (state && state.job && state.job.running) poll = setTimeout(refresh, 1000);
    else if (state && state.job && state.job.ready && lastRequest) {
      var completed = lastRequest; lastRequest = null;
      await loadEnv(); await load();
      if (completed.action === "codex") {
        try { await api("POST", "/api/login", {tool:"codex"}); pendingLogin = "codex"; renderOptions(); }
        catch (_) { announce(t("ログインボタンからもう一度お試しください。", "Try the login button again.", "请再次点击登录按钮。")); }
      } else if (completed.action !== "runtime") { go("finish"); render(); }
    }
  }
  async function begin(request) {
    if (busy || (state && state.job && state.job.running)) return;
    busy = true; lastRequest = request; render();
    try { state = await api("POST", "/api/provision", request); render(); }
    catch (_) { announce(t("開始できませんでした。画面を更新してもう一度お試しください。", "Could not start. Refresh this page and retry.", "无法开始，请刷新页面后重试。")); }
    finally { busy = false; render(); }
    await refresh();
  }
  var previousLoad = window.load;
  window.load = async function () { await previousLoad(); await refresh(); };
  var previousLoadEnv = window.loadEnv;
  window.loadEnv = async function () { await previousLoadEnv(); render(); };
  var previousFinish = window.renderFinish;
  window.renderFinish = function () { previousFinish(); render(); };
  if (!(ENV && (ENV.codex || ENV.opencode))) $("options").before(local);
  setTimeout(refresh, 200);
})();
