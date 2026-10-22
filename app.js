// Tabs, hash routing, outline, scroll spy, command palette, copy, lightbox.
// No framework, no build step, no network calls.

const DOCS = {
  readme: "README.md",
  bench: "BENCHMARKS.md",
  commands: "COMMANDS.md",
  safety: "SAFETY.md",
  web: "WEB.md",
  screens: "SCREENS.md",
};

const LANG = (document.documentElement.lang || "ja").toLowerCase().startsWith("ja") ? "ja" : "en";

const STRINGS = {
  ja: {
    copy: "コピー",
    copied: "コピー済み",
    copyFailed: "失敗",
    copiedToast: "コピーしました",
    copyFailedToast: "コピーできませんでした",
    theme: "テーマ",
    themeToast: "テーマ: ",
    print: "印刷",
    toggleTheme: "テーマを切り替える",
    repo: "GitHub リポジトリ",
    noResults: "候補なし",
    kindAction: "操作",
    kindLink: "リンク",
  },
  en: {
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Failed",
    copiedToast: "Copied to clipboard",
    copyFailedToast: "Could not copy",
    theme: "Theme",
    themeToast: "Theme: ",
    print: "Print",
    toggleTheme: "Switch theme",
    repo: "GitHub repository",
    noResults: "No results",
    kindAction: "action",
    kindLink: "link",
  },
};

const UI = STRINGS[LANG];

const root = document.documentElement;
const tabs = Array.from(document.querySelectorAll(".tab"));
const treeFiles = Array.from(document.querySelectorAll(".tree-file[data-doc]"));
const articles = Array.from(document.querySelectorAll(".doc"));
const outline = document.getElementById("outline");
const crumbFile = document.getElementById("crumb-file");
const statusFile = document.getElementById("status-file");
const content = document.getElementById("content");
const toast = document.getElementById("toast");
const langSwitch = document.getElementById("lang-switch");
const docnavPrev = document.getElementById("docnav-prev");
const docnavNext = document.getElementById("docnav-next");

let activeDoc = "readme";
let spy = null;
let toastTimer = 0;

/* ---------- helpers ---------- */

function docNameFromHash() {
  const name = location.hash.replace(/^#\/?/, "");
  return Object.prototype.hasOwnProperty.call(DOCS, name) ? name : "readme";
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1600);
}

function setCurrent(element, value) {
  if (value) {
    element.setAttribute("aria-current", "page");
  } else {
    element.removeAttribute("aria-current");
  }
}

/* ---------- outline + scroll spy ---------- */

let slugCounter = 0;

function ensureId(heading) {
  if (!heading.id) {
    slugCounter += 1;
    heading.id = "section-" + slugCounter;
  }
  return heading.id;
}

function buildOutline(article) {
  outline.replaceChildren();
  const headings = Array.from(article.querySelectorAll("h2"));
  for (const heading of headings) {
    const id = ensureId(heading);
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#" + id;
    link.textContent = heading.textContent;
    link.dataset.target = id;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      link.setAttribute("aria-current", "true");
    });
    item.append(link);
    outline.append(item);
  }

  if (spy) {
    window.removeEventListener("scroll", spy);
    spy = null;
  }
  if (headings.length === 0) {
    return;
  }

  const links = new Map();
  for (const link of outline.querySelectorAll("a")) {
    links.set(link.dataset.target, link);
  }

  // Pick the last heading whose top edge has passed the title bar.
  const mark = () => {
    let current = null;
    const atBottom =
      window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
    if (atBottom) {
      current = headings[headings.length - 1].id;
    } else {
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= 120) {
          current = heading.id;
        }
      }
    }
    for (const [id, link] of links) {
      if (id === current) {
        link.setAttribute("aria-current", "true");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };

  let queued = false;
  spy = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      mark();
    });
  };
  window.addEventListener("scroll", spy, { passive: true });
  mark();
}

/* ---------- routing ---------- */

function showDoc(name, options) {
  const settings = options || {};
  if (!Object.prototype.hasOwnProperty.call(DOCS, name)) {
    name = "readme";
  }
  activeDoc = name;

  for (const article of articles) {
    article.hidden = article.id !== "doc-" + name;
  }
  for (const tab of tabs) {
    setCurrent(tab, tab.dataset.doc === name);
  }
  for (const file of treeFiles) {
    setCurrent(file, file.dataset.doc === name);
  }
  if (langSwitch) {
    langSwitch.href = langSwitch.dataset.base + "#" + name;
  }
  crumbFile.textContent = DOCS[name];
  statusFile.textContent = DOCS[name];

  const order = Object.keys(DOCS);
  const position = order.indexOf(name);
  const prevKey = order[(position - 1 + order.length) % order.length];
  const nextKey = order[(position + 1) % order.length];
  docnavPrev.querySelector(".docnav-name").textContent = DOCS[prevKey];
  docnavNext.querySelector(".docnav-name").textContent = DOCS[nextKey];
  docnavPrev.dataset.doc = prevKey;
  docnavNext.dataset.doc = nextKey;

  const article = document.getElementById("doc-" + name);
  if (article) {
    buildOutline(article);
  }

  if (settings.hash !== false && location.hash !== "#" + name) {
    history.pushState(null, "", "#" + name);
  }
  updateTabOverflow();
  if (!settings.keepScroll) {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
  if (settings.focusContent) {
    content.focus({ preventScroll: true });
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showDoc(tab.dataset.doc));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = tabs.indexOf(tab);
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    showDoc(tabs[next].dataset.doc);
  });
}

for (const file of treeFiles) {
  file.addEventListener("click", () => {
    showDoc(file.dataset.doc);
    if (window.matchMedia("(max-width: 880px)").matches) {
      content.focus({ preventScroll: true });
      content.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });
}

for (const jump of document.querySelectorAll("[data-jump]")) {
  jump.addEventListener("click", (event) => {
    event.preventDefault();
    showDoc(jump.dataset.jump);
  });
}

for (const button of [docnavPrev, docnavNext]) {
  button.addEventListener("click", () => showDoc(button.dataset.doc));
}

window.addEventListener("popstate", () => showDoc(docNameFromHash(), { hash: false }));

/* ---------- code blocks ---------- */

const segItems = Array.from(document.querySelectorAll(".seg-item"));

function pickPlatform(code) {
  for (const item of segItems) {
    const active = item.dataset.code === code;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  for (const panel of document.querySelectorAll("[data-code-panel]")) {
    const target = panel.closest("[data-code-group]");
    if (!target) continue;
    panel.hidden = panel.dataset.codePanel !== code;
  }
  for (const button of document.querySelectorAll(".copy")) {
    if (button.dataset.copy === "unix" || button.dataset.copy === "windows") {
      button.dataset.copy = code;
    }
  }
}

for (const item of segItems) {
  item.addEventListener("click", () => pickPlatform(item.dataset.code));
}

const copyLabels = new WeakMap();

for (const button of document.querySelectorAll(".copy")) {
  copyLabels.set(button, button.textContent);
  button.addEventListener("click", async () => {
    const panel = document.querySelector('[data-code-panel="' + button.dataset.copy + '"]');
    if (!panel) return;
    const text = panel.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = UI.copied;
      showToast(UI.copiedToast);
    } catch {
      button.textContent = UI.copyFailed;
      showToast(UI.copyFailedToast);
    }
    setTimeout(() => {
      button.textContent = copyLabels.get(button) || UI.copy;
    }, 1500);
  });
}

/* ---------- command filter ---------- */

const filter = document.getElementById("cmd-filter");
const cmdRows = filter
  ? Array.from(document.querySelectorAll("#cmd-table tbody tr"))
  : [];
const cmdCount = document.getElementById("cmd-count");
const cmdEmpty = document.getElementById("cmd-empty");

function updateFilter() {
  if (!filter) return;
  const query = filter.value.trim().toLowerCase();
  let shown = 0;
  for (const row of cmdRows) {
    const hit = query === "" || row.textContent.toLowerCase().includes(query);
    row.hidden = !hit;
    if (hit) shown += 1;
  }
  cmdCount.textContent = shown + " / " + cmdRows.length;
  cmdEmpty.hidden = shown !== 0;
}

if (filter) {
  filter.addEventListener("input", updateFilter);
  updateFilter();
}

/* ---------- theme ---------- */

const themeButton = document.getElementById("theme-toggle");
const themeOrder = ["auto", "dark", "light"];
const THEME_KEY = "rdsh-site-theme";

function applyTheme(theme) {
  root.dataset.theme = theme;
  themeButton.title = UI.theme + ": " + theme;
  themeButton.setAttribute("aria-label", UI.theme + ": " + theme);
}

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved && themeOrder.includes(saved)) {
    applyTheme(saved);
  }
} catch {
  /* private mode: keep the media-query default */
}

themeButton.addEventListener("click", () => {
  const current = root.dataset.theme || "auto";
  const next = themeOrder[(themeOrder.indexOf(current) + 1) % themeOrder.length];
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  showToast(UI.themeToast + next);
});

/* ---------- lightbox ---------- */

const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxCaption = document.getElementById("lightbox-caption");

for (const zoom of document.querySelectorAll(".figure-zoom")) {
  zoom.addEventListener("click", () => {
    lightboxImg.src = zoom.dataset.full;
    lightboxImg.alt = zoom.dataset.caption || "";
    lightboxCaption.textContent = zoom.dataset.caption || "";
    lightbox.showModal();
  });
}

document.getElementById("lightbox-close").addEventListener("click", () => lightbox.close());

lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) {
    lightbox.close();
  }
});

/* ---------- command palette ---------- */

const palette = document.getElementById("palette");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
const paletteEmpty = document.getElementById("palette-empty");

const paletteEntries = [];

for (const [key, title] of Object.entries(DOCS)) {
  paletteEntries.push({ label: title, kind: "file", run: () => showDoc(key) });
}

for (const article of articles) {
  const docKey = article.id.replace(/^doc-/, "");
  for (const heading of article.querySelectorAll("h2")) {
    paletteEntries.push({
      label: heading.textContent,
      kind: DOCS[docKey],
      run: () => {
        showDoc(docKey);
        const id = ensureId(heading);
        const target = document.getElementById(id);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      },
    });
  }
}

for (const row of document.querySelectorAll("#cmd-table tbody tr")) {
  const code = row.querySelector("code");
  if (!code) continue;
  const purpose = row.querySelector("td:nth-child(2)");
  paletteEntries.push({
    label: "rdsh " + code.textContent,
    kind: "command",
    hint: purpose ? purpose.textContent : "",
    run: () => {
      showDoc("commands");
      filter.value = code.textContent;
      updateFilter();
      filter.focus();
    },
  });
}

paletteEntries.push(
  { label: UI.toggleTheme, kind: UI.kindAction, run: () => themeButton.click() },
  { label: UI.print, kind: UI.kindAction, run: () => window.print() },
  {
    label: UI.repo,
    kind: UI.kindLink,
    run: () => window.open("https://github.com/jimoto-no-llm/rustdsh", "_blank", "noopener"),
  }
);

let paletteMatches = [];
let paletteIndex = 0;

function renderPalette(query) {
  const needle = query.trim().toLowerCase();
  paletteMatches = paletteEntries
    .filter((entry) => needle === "" || (entry.label + " " + entry.kind).toLowerCase().includes(needle))
    .slice(0, 40);
  paletteIndex = 0;
  paletteList.replaceChildren();

  paletteMatches.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = "palette-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === paletteIndex));

    const label = document.createElement("span");
    label.textContent = entry.label;

    const kind = document.createElement("span");
    kind.className = "palette-kind";
    kind.textContent = entry.kind;

    item.append(label, kind);
    item.addEventListener("mouseenter", () => {
      paletteIndex = index;
      syncSelection();
    });
    item.addEventListener("click", () => {
      palette.close();
      entry.run();
    });
    paletteList.append(item);
  });

  paletteEmpty.hidden = paletteMatches.length !== 0;
}

function syncSelection() {
  const items = paletteList.children;
  for (let i = 0; i < items.length; i += 1) {
    items[i].setAttribute("aria-selected", String(i === paletteIndex));
  }
  const current = items[paletteIndex];
  if (current) {
    current.scrollIntoView({ block: "nearest" });
  }
}

function openPalette() {
  if (!palette.open) {
    palette.showModal();
  }
  paletteInput.value = "";
  renderPalette("");
  paletteInput.focus();
}

function activatePalette() {
  const entry = paletteMatches[paletteIndex];
  if (!entry) return;
  palette.close();
  entry.run();
}

document.getElementById("search-open").addEventListener("click", openPalette);

paletteInput.addEventListener("input", () => renderPalette(paletteInput.value));

paletteInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    paletteIndex = Math.min(paletteIndex + 1, paletteMatches.length - 1);
    syncSelection();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    paletteIndex = Math.max(paletteIndex - 1, 0);
    syncSelection();
  } else if (event.key === "Enter") {
    event.preventDefault();
    activatePalette();
  }
});

palette.addEventListener("close", () => {
  paletteInput.blur();
});

document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (!typing && event.key === "/") {
    event.preventDefault();
    openPalette();
  }
});

/* ---------- tab overflow hint ---------- */

const tabStrip = document.querySelector(".tabs");

function updateTabOverflow() {
  if (!tabStrip) return;
  tabStrip.classList.toggle("is-scrollable", tabStrip.scrollWidth > tabStrip.clientWidth + 2);
}

window.addEventListener("resize", updateTabOverflow);
window.addEventListener("load", updateTabOverflow);

/* ---------- misc ---------- */

document.getElementById("print").addEventListener("click", () => window.print());

/* ---------- boot ---------- */

applyTheme(root.dataset.theme || "auto");
const initialDoc = docNameFromHash();
showDoc(initialDoc, { hash: false });
history.replaceState(null, "", "#" + initialDoc);
