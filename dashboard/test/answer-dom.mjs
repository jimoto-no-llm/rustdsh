import fs from "node:fs/promises";
import vm from "node:vm";

const html = await fs.readFile(new URL("../ui.html", import.meta.url), "utf8");

// A small DOM/event boundary for executing the shipped browser module. It does
// not implement answer handling: all drafts, requests and rendering run app.mjs.
class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, ...extra };
    const listeners = [...(this.listeners.get(type) || [])];
    if (typeof this["on" + type] === "function") listeners.push(this["on" + type]);
    return Promise.all(listeners.map((listener) => listener(event)));
  }
}

class Element extends Events {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.value = "";
    this.disabled = false;
    this.readOnly = false;
    this.hidden = false;
    this.id = "";
    this.className = "";
    this._text = "";
  }
  set textContent(value) {
    this.replaceChildren();
    this._text = String(value);
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = "";
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const match = selector.match(/^([a-z][a-z0-9-]*)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?(:checked)?$/i);
    if (!match) throw new Error("Unsupported test selector: " + selector);
    const [, tag, className, attribute, value, checked] = match;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (className && !this.className.split(" ").includes(className)) return false;
    if (checked && !this.checked) return false;
    if (!attribute) return true;
    const actual = attribute.startsWith("data-")
      ? this.dataset[attribute.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())]
      : ["open", "disabled", "checked"].includes(attribute)
        ? this[attribute] ? "" : undefined
        : this.getAttribute(attribute) ?? this[attribute];
    return actual !== undefined && actual !== null && (value === undefined || actual === value);
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) {
    for (let element = this; element; element = element.parentElement)
      if (element.matches(selector)) return element;
    return null;
  }
  scrollIntoView() {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  setSelectionRange(start, end, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  click() {
    if (!this.disabled) return this.dispatch("click");
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    return this.dispatch("close");
  }
}

export class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

export function stateFor(projectId = "project-alpha", questionIds = ["Q1"]) {
  return {
    schema: 1,
    project: { id: projectId, name: projectId, root: "/projects/" + projectId },
    revision: 1,
    updated_at: "2026-10-08T00:00:00.000Z",
    metrics: {}, tasks: [], events: [], feedback: [],
    questions: questionIds.map((id) => ({
      id, question: "Question " + id, urgency: "normal", default_action: "",
      created_at: "2026-10-08T00:00:00.000Z", answer: null,
    })),
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function loadDashboard({
  state = stateFor(), storage = new MemoryStorage(), postAnswer,
  readConfig, readState, refreshShare, readQr, readDiagnostics,
  pathname = "/", hash = "#key=test-browser-token",
} = {}) {
  const document = new Events();
  document.body = new Element("body", document);
  document.createElement = (tag) => new Element(tag, document);
  document.getElementById = (id) => document.body.querySelector("#" + id);
  document.querySelector = (selector) => document.body.querySelector(selector);
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  // Keep the real HTML hierarchy: overview and panel modules query inside their
  // roots, so a flat collection of IDs would skip their actual render paths.
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)[1];
  const stack = [document.body];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const token of body.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][a-z0-9-]*)\b[^>]*>|([^<]+)/gi)) {
    const [markup, tag, text] = token;
    if (markup.startsWith("<!--")) continue;
    if (text) {
      // Static indentation is immaterial; application strings use textContent.
      if (text.trim()) stack.at(-1)._text += text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      continue;
    }
    if (markup.startsWith("</")) {
      while (stack.length > 1) if (stack.pop().tagName === tag.toUpperCase()) break;
      continue;
    }
    const element = document.createElement(tag);
    const attributes = markup.slice(tag.length + 1).replace(/\/?>$/, "");
    for (const attribute of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      const name = attribute[1], value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      element.setAttribute(name, value);
      if (name === "class") element.className = value;
      else if (name.startsWith("data-")) element.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
      else if (["hidden", "disabled", "checked", "open", "required", "readOnly"].includes(name)) element[name] = true;
      else if (["id", "type", "name", "value"].includes(name)) element[name] = value;
    }
    stack.at(-1).append(element);
    if (!voidTags.has(tag.toLowerCase()) && !markup.endsWith("/>")) stack.push(element);
  }
  document.activeElement = document.body;
  const requests = [], sources = [];
  const window = new Events();
  window.scrollTo = () => {};
  // Real Response objects let tests distinguish an HTTP rejection from a
  // transport exception without implementing authentication in this boundary.
  const response = (value) => value instanceof Response ? value :
    ({ ok: true, status: 200, json: async () => structuredClone(value) });
  const fetch = async (url, options = {}) => {
    const route = new URL(url, "http://dashboard.test").pathname.replace(/^\/(?:_rdsh\/)?api\//, "");
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ route, method: options.method || "GET", body, headers: { ...options.headers } });
    if (route === "config") return response(readConfig ? await readConfig() : {
      kind: "project", project: state.project,
      share: { state: "disabled", message: "Local test", url: null },
    });
    if (route === "state") return response(readState ? await readState() : state);
    if (route === "share/refresh") return response(refreshShare ? await refreshShare() : {});
    if (route === "diagnostics") return response(readDiagnostics ? await readDiagnostics() : {});
    if (route === "qr.svg") return readQr ? await readQr() : new Response("<svg />", {
      headers: { "content-type": "image/svg+xml" },
    });
    if (route === "update/answer") {
      if (postAnswer) return response(await postAnswer(body));
      state.questions.find((question) => question.id === body.id).answer = body.answer;
      state.revision++;
      return response(state);
    }
    throw new Error("Unexpected test request: " + route);
  };
  class EventSource extends Events {
    constructor(url) { super(); this.url = url; sources.push(this); }
    close() {}
  }
  const location = { pathname, hash, search: "", origin: "http://dashboard.test" };
  Object.assign(window, { document, location, sessionStorage: storage });
  const intervals = [];
  const context = vm.createContext({
    document, window, location, sessionStorage: storage,
    history: { replaceState(_state, _title, value) {
      const next = new URL(value, location.origin);
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    } }, fetch, EventSource,
    URL, URLSearchParams, console, setTimeout, clearTimeout, crypto,
    setInterval: (callback, milliseconds) => { intervals.push({ callback, milliseconds }); return intervals.length; },
    clearInterval: () => {},
  });
  // Evaluate every shipped UI module in this document's VM. Only module syntax
  // is adapted; renderers and state transitions are never replaced with mocks.
  const modules = new Map();
  async function evaluateModule(url) {
    if (modules.has(url.href)) return modules.get(url.href);
    const evaluation = (async () => {
      let source = await fs.readFile(url, "utf8");
      const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map(match => match[1]);
      source = source.replace(/^export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?\s*$/gm,
        (_, bindings, reference) => {
          const name = "reexport" + names.length;
          const assignments = bindings.split(",").map(binding => binding.trim()).filter(Boolean).map(binding => {
            const [original, alias = original] = binding.split(/\s+as\s+/);
            names.push(alias + ": " + name + "." + original);
            return alias;
          });
          if (!reference.startsWith("./") || !assignments.length) throw new Error("Unsupported UI re-export");
          return "const " + name + " = await importUi(" + JSON.stringify(new URL(reference, url).href) + ");";
        });
      source = source.replace(/^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?\s*$/gm,
        (_, bindings, reference) => {
          if (!reference.startsWith("./")) throw new Error("Only relative UI imports are supported");
          return "const {" + bindings.replace(/\s+as\s+/g, ": ") + "} = await importUi(" + JSON.stringify(new URL(reference, url).href) + ");";
        }).replace(/^export\s+/gm, "");
      return vm.runInContext("(async () => {\n" + source + "\nreturn {" + names.join(",") + "};\n})()", context, { filename: url.pathname });
    })();
    modules.set(url.href, evaluation);
    return evaluation;
  }
  context.importUi = href => evaluateModule(new URL(href));
  await evaluateModule(new URL("../app.mjs", import.meta.url));
  return {
    document, window, requests, storage, state,
    async interval(milliseconds) { await Promise.all(intervals.filter(item => item.milliseconds === milliseconds).map(item => item.callback())); },
    element: (id) => document.getElementById(id),
    form(id = "Q1") {
      return document.getElementById("question-" + id)?.querySelector("form") || null;
    },
    textarea(id = "Q1") { return this.form(id)?.querySelector("textarea") || null; },
    button(id = "Q1") { return this.form(id)?.querySelector("button") || null; },
    async input(value, id = "Q1") {
      const area = this.textarea(id);
      area.value = value;
      await area.dispatch("input");
    },
    submit(id = "Q1") { return this.form(id).dispatch("submit"); },
    async changed() {
      if (!sources[0]) throw new Error("Dashboard did not connect to its event stream");
      await sources[0].dispatch("changed");
    },
    async streamOpen() {
      if (!sources[0]) throw new Error("Dashboard did not connect to its event stream");
      await sources[0].onopen?.();
    },
    async streamError() {
      if (!sources[0]) throw new Error("Dashboard did not connect to its event stream");
      await sources[0].onerror?.({ type: "error" });
    },
    answers() { return requests.filter((request) => request.route === "update/answer"); },
  };
}
