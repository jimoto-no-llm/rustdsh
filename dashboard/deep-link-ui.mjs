export function deepLinkButton(node, makeDeepLink, kind, id, label, runId) {
  if (typeof makeDeepLink !== "function") return null;
  const control = node("span", undefined, "deep-link-control");
  const button = node("button", "リンクをコピー");
  button.type = "button";
  button.setAttribute(
    "aria-label",
    `${label}への認証情報を含まないリンクをコピー`,
  );
  const fallback = node("input");
  fallback.type = "text";
  fallback.readOnly = true;
  fallback.hidden = true;
  fallback.setAttribute("aria-label", `${label}の共有用リンク`);
  const status = node("span", "", "sub");
  status.setAttribute("role", "status");
  button.addEventListener("click", async () => {
    button.disabled = true;
    let href;
    try {
      href = makeDeepLink(kind, id, runId);
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(href);
      status.textContent = "リンクをコピーしました。認証情報は含まれません。";
    } catch {
      if (href) {
        fallback.value = href;
        fallback.hidden = false;
        fallback.focus();
        fallback.select();
        status.textContent =
          "自動コピーできません。選択したリンクを手動でコピーしてください。認証情報は含まれません。";
      } else {
        status.textContent = "リンクを作れません。projectの状態を読み直してください。";
      }
    } finally {
      button.disabled = false;
    }
  });
  control.append(button, fallback, status);
  return control;
}
