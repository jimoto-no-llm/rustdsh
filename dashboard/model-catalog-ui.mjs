export const MODEL_CATALOG = [
  {
    id: "mistral-large-preview",
    name: "Mistral Large",
    architecture: "MoE",
    status: "公開プレビュー",
    weights: "10月末公開予定",
    total_label: "約1兆",
    active_label: "490億",
    // 表示用概数（報告値）。有効/総 = 49/100 = 0.49 の横棒用。
    total_value: 100,
    active_value: 49,
    certainty: "報告値",
    source_ref: "Mistral AI 公開情報（手入力カタログ）",
  },
];

export function catalogActiveRatio(entry) {
  if (!entry || entry.active_value == null || entry.total_value == null) return null;
  const active = Number(entry.active_value);
  const total = Number(entry.total_value);
  if (!Number.isFinite(active) || !Number.isFinite(total)) return null;
  if (total <= 0 || active < 0) return null;
  return active / total;
}

function paramText(value, label) {
  if (value == null || value === "") return "未取得";
  return label || String(value);
}

export function createModelCatalogPanel(container, node, initialCatalog = MODEL_CATALOG) {
  function render(catalog) {
    const list = catalog === undefined ? initialCatalog : catalog;
    container.replaceChildren();
    container.append(node("h2", "モデルカタログ（試作）"));
    container.append(
      node(
        "p",
        "手入力の報告値です。断定した実測ではありません。出所を確認してください。",
        "sub",
      ),
    );
    if (!Array.isArray(list) || list.length === 0) {
      container.append(node("p", "モデルカタログは未登録です。", "sub"));
      return;
    }
    for (const entry of list) {
      const card = node("section", undefined, "card");
      card.append(node("h3", entry.name || "名称未取得"));
      card.append(
        node(
          "p",
          (entry.architecture || "構成未取得") +
            " · " +
            (entry.status || "状態未取得") +
            " · 重み " +
            (entry.weights || "未取得"),
          "detail",
        ),
      );
      const totalText = paramText(entry.total_value, entry.total_label ? "総 " + entry.total_label : undefined);
      const activeText = paramText(entry.active_value, entry.active_label ? "有効 " + entry.active_label : undefined);
      card.append(node("p", "総パラメータ（報告値）: " + totalText, "detail"));
      card.append(node("p", "有効パラメータ（報告値）: " + activeText, "detail"));
      card.append(node("p", "確度: " + (entry.certainty || "未取得"), "detail"));
      card.append(node("p", "出所: " + (entry.source_ref || "未取得"), "detail"));
      const ratio = catalogActiveRatio(entry);
      if (ratio == null) {
        card.append(node("p", "有効/総の比率は未取得です。0にはしません。", "detail"));
      } else {
        const width = 200;
        const height = 14;
        const svg = node("svg");
        if (typeof svg.setAttribute === "function") {
          svg.setAttribute("width", String(width));
          svg.setAttribute("height", String(height));
          svg.setAttribute("viewBox", "0 0 " + width + " " + height);
          svg.setAttribute("role", "img");
        }
        const bg = node("rect");
        if (typeof bg.setAttribute === "function") {
          bg.setAttribute("x", "0");
          bg.setAttribute("y", "0");
          bg.setAttribute("width", String(width));
          bg.setAttribute("height", String(height));
        }
        const fg = node("rect");
        if (typeof fg.setAttribute === "function") {
          fg.setAttribute("x", "0");
          fg.setAttribute("y", "0");
          fg.setAttribute("width", String(Math.round(width * ratio)));
          fg.setAttribute("height", String(height));
        }
        // テスト用の比率保持（実DOMでは dataset、モックでは直置き）
        try {
          if (svg.dataset) svg.dataset.ratio = String(ratio);
          else svg.ratio = ratio;
        } catch {}
        try {
          if (fg.dataset) fg.dataset.ratio = String(ratio);
          else fg.ratio = ratio;
        } catch {}
        if (typeof svg.append === "function") svg.append(bg, fg);
        else if (typeof svg.appendChild === "function") {
          svg.appendChild(bg);
          svg.appendChild(fg);
        }
        card.append(svg);
        card.append(
          node("p", "有効/総（報告値の表示用比率）: " + ratio.toFixed(2), "detail"),
        );
      }
      container.append(card);
    }
  }
  render(initialCatalog);
  return render;
}
