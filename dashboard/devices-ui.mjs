function textElement(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}

function deviceLink(config, base, credential) {
  const url = new URL(config.share.url || location.origin + base, location.href);
  url.pathname = base;
  url.search = "";
  url.hash = `key=${encodeURIComponent(credential)}`;
  return url.href;
}

export async function setupDeviceAccess({ api, config, base }) {
  const detail = document.getElementById("device-detail");
  const notice = document.getElementById("device-access-notice");
  if (!["project", "harness"].includes(config.kind) || !config.device_access)
    return;
  const controlLabel =
    config.kind === "harness" ? "管理中の実行を停止" : "追指示・質問取消し";

  if (config.device_access.role === "device") {
    const capabilities = new Set(config.device_access.capabilities);
    const labels = ["閲覧"];
    if (capabilities.has("reply")) labels.push("質問への回答");
    if (capabilities.has("control")) labels.push(controlLabel);
    notice.textContent = `この端末の権限: ${labels.join("・")}。別の端末の権限を変更するには所有者に依頼してください。`;
    notice.hidden = false;
    document.getElementById("share-toggle").hidden = true;
    document.getElementById("share").hidden = true;
    if (!capabilities.has("control"))
      document.getElementById("instruction-panel").inert = true;
    document.getElementById("budget-admission").inert = true;
    return;
  }
  if (config.device_access.role !== "owner") return;

  detail.hidden = false;
  const form = document.getElementById("device-create-form");
  const name = document.getElementById("device-name");
  const reply = document.getElementById("device-reply");
  const control = document.getElementById("device-control");
  if (config.kind === "harness") {
    document.getElementById("device-reply-option").hidden = true;
    document.getElementById("device-control-label").textContent = controlLabel;
  }
  const status = document.getElementById("device-status");
  const list = document.getElementById("device-list");
  const credential = document.getElementById("device-credential");
  const link = document.getElementById("device-link");

  async function refresh() {
    const result = await api("devices");
    list.replaceChildren();
    if (!result.devices.length) {
      list.append(textElement("p", "登録済み端末はありません。"));
      return;
    }
    for (const device of result.devices) {
      const item = textElement("article", undefined, "event");
      const heading = textElement(
        "h3",
        `${device.name} · ${device.status === "active" ? "有効" : "失効済み"}`,
      );
      const permissions = device.capabilities
        .map((capability) =>
          capability === "read"
            ? "閲覧"
            : capability === "reply"
              ? "質問への回答"
              : capability === "control"
                ? controlLabel
                : capability,
        )
        .join("・");
      item.append(heading);
      item.append(textElement("p", `権限: ${permissions}`));
      item.append(
        textElement(
          "p",
          `作成: ${new Date(device.created_at).toLocaleString("ja-JP")} · 最終利用: ${device.last_used_at ? new Date(device.last_used_at).toLocaleString("ja-JP") : "未使用"}`,
          "sub",
        ),
      );
      if (device.status === "active") {
        const revoke = textElement("button", "この端末を失効");
        revoke.type = "button";
        revoke.addEventListener("click", async () => {
          if (
            !confirm(
              `${device.name} の鍵を失効し、接続中の画面を切断しますか？`,
            )
          )
            return;
          revoke.disabled = true;
          try {
            await api(`devices/${encodeURIComponent(device.id)}`, undefined, "DELETE");
            status.textContent = `${device.name} を失効しました。`;
            await refresh();
          } catch (error) {
            status.textContent = error.message;
            revoke.disabled = false;
          }
        });
        item.append(revoke);
      }
      list.append(item);
    }
  }

  document.getElementById("device-refresh").addEventListener("click", async () => {
    try {
      await refresh();
      status.textContent = "一覧を更新しました。";
    } catch (error) {
      status.textContent = error.message;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const capabilities = ["read"];
    if (reply.checked) capabilities.push("reply");
    if (control.checked) capabilities.push("control");
    document.getElementById("device-create").disabled = true;
    status.textContent = "端末鍵を作成しています…";
    try {
      const result = await api("devices", { name: name.value, capabilities });
      link.value = deviceLink(config, base, result.credential);
      credential.hidden = false;
      name.value = "";
      reply.checked = false;
      control.checked = false;
      status.textContent = config.share.url
        ? "鍵を一度だけ表示しました。リンクを対象端末へ安全に渡してください。"
        : "鍵を一度だけ表示しました。共有URLが未設定のため、このリンクはこのPCからのみ接続できます。";
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      document.getElementById("device-create").disabled = false;
    }
  });
  document.getElementById("device-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link.value);
      status.textContent = "端末リンクをコピーしました。";
    } catch {
      link.focus();
      link.select();
      status.textContent = "リンクを選択しました。コピーして対象端末へ渡してください。";
    }
  });
  document.getElementById("device-clear-link").addEventListener("click", () => {
    link.value = "";
    credential.hidden = true;
    status.textContent = "一度だけ表示した鍵を閉じました。再表示はできません。";
  });
  try {
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
}
