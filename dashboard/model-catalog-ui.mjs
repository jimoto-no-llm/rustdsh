import { text } from "./locale.mjs";

export const MODEL_CATALOG = [
  {
    id: "mistral-large-preview",
    name: "Mistral Large",
    architecture: "MoE",
    status: text("model.preview"),
    weights: text("model.weightsPlan"),
    total_label: text("model.trillion"),
    active_label: text("model.billion"),
    // 表示用概数（報告値）。有効/総 = 49/100 = 0.49 の横棒用。
    total_value: 100,
    active_value: 49,
    certainty: text("model.reported"),
    source_ref: text("model.sourceBuiltin"),
  },
];

export function catalogActiveRatio(entry) {
  if (!entry || entry.active_value == null || entry.total_value == null)
    return null;
  const active = Number(entry.active_value);
  const total = Number(entry.total_value);
  if (!Number.isFinite(active) || !Number.isFinite(total)) return null;
  if (total <= 0 || active < 0) return null;
  return active / total;
}

function paramText(value, label) {
  if (value == null || value === "") return text("model.unavailable");
  return label || String(value);
}

export function createModelCatalogPanel(
  container,
  node,
  initialCatalog = MODEL_CATALOG,
) {
  function render(catalog) {
    const list = catalog === undefined ? initialCatalog : catalog;
    container.replaceChildren();
    container.append(node("h2", text("model.heading")));
    container.append(node("p", text("model.intro"), "sub"));
    if (!Array.isArray(list) || list.length === 0) {
      container.append(node("p", text("model.empty"), "sub"));
      return;
    }
    for (const entry of list) {
      const card = node("section", undefined, "card");
      card.append(node("h3", entry.name || text("model.noName")));
      card.append(
        node(
          "p",
          text("model.summary", {
            architecture: entry.architecture || text("model.noArchitecture"),
            status: entry.status || text("model.noStatus"),
            weights: entry.weights || text("model.unavailable"),
          }),
          "detail",
        ),
      );
      const totalText = paramText(
        entry.total_value,
        entry.total_label
          ? text("model.totalLabel", { value: entry.total_label })
          : undefined,
      );
      const activeText = paramText(
        entry.active_value,
        entry.active_label
          ? text("model.activeLabel", { value: entry.active_label })
          : undefined,
      );
      card.append(
        node("p", text("model.total", { value: totalText }), "detail"),
      );
      card.append(
        node("p", text("model.active", { value: activeText }), "detail"),
      );
      card.append(
        node(
          "p",
          text("model.certainty", {
            value: entry.certainty || text("model.unavailable"),
          }),
          "detail",
        ),
      );
      card.append(
        node(
          "p",
          text("model.source", {
            value: entry.source_ref || text("model.unavailable"),
          }),
          "detail",
        ),
      );
      const ratio = catalogActiveRatio(entry);
      if (ratio == null) {
        card.append(node("p", text("model.missingRatio"), "detail"));
      } else {
        const width = 200;
        const height = 14;
        const svg = node("svg");
        if (typeof svg.setAttribute === "function") {
          svg.setAttribute("width", String(width));
          svg.setAttribute("height", String(height));
          svg.setAttribute("viewBox", "0 0 " + width + " " + height);
          svg.setAttribute("role", "img");
          svg.setAttribute(
            "aria-label",
            text("model.ratio", { value: ratio.toFixed(2) }),
          );
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
          node("p", text("model.ratio", { value: ratio.toFixed(2) }), "detail"),
        );
      }
      container.append(card);
    }
  }
  render(initialCatalog);
  return render;
}
