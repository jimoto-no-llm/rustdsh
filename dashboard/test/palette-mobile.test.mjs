import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboard } from "./answer-dom.mjs";

function viewportFor(ui, values) {
  const viewport = new ui.window.constructor();
  Object.assign(viewport, values);
  ui.window.visualViewport = viewport;
  return viewport;
}

test("opening the palette focuses search without scrolling and its close button restores focus", async () => {
  const ui = await loadDashboard();
  const opener = ui.element("palette-toggle");
  const search = ui.element("palette-search");
  const focus = search.focus.bind(search);
  let focusOptions;
  search.focus = (options) => { focusOptions = options; focus(); };
  opener.focus();
  await opener.click();
  assert.equal(focusOptions?.preventScroll, true);
  assert.ok(ui.document.activeElement === search);
  const close = ui.element("palette-close");
  assert.ok(close, "a phone user must be able to close the dialog without Escape");
  await close.click();
  assert.equal(ui.element("palette").open, false);
  assert.ok(ui.document.activeElement === opener);
  await ui.document.dispatch("keydown", { ctrlKey: true, key: "k" });
  assert.equal(ui.element("palette").open, true);
  assert.ok(ui.document.activeElement === search);
});

test("an open palette fits the visual viewport after keyboard resize and viewport panning", async () => {
  const ui = await loadDashboard();
  const viewport = viewportFor(ui, { width: 462, height: 754, offsetLeft: 0, offsetTop: 0, scale: 0.85 });
  const palette = ui.element("palette");
  await ui.element("palette-toggle").click();
  assert.equal(palette.style.width, "422px");
  assert.equal(palette.style.maxHeight, "714px");
  Object.assign(viewport, { width: 393, height: 329, offsetLeft: 34.656, offsetTop: 99, scale: 1 });
  await viewport.dispatch("resize");
  assert.equal(palette.style.width, "353px");
  assert.equal(palette.style.maxHeight, "289px");
  assert.equal(palette.style.left, "54.656px");
  assert.equal(palette.style.top, "119px");
  viewport.offsetTop = 120;
  await viewport.dispatch("scroll");
  assert.equal(palette.style.top, "140px");
  assert.equal(viewport.scale, 1, "viewport fitting must not reset the user's zoom");

  await ui.element("palette-close").click();
  assert.equal(palette.style.width, "");
  assert.equal(palette.style.maxHeight, "");
  assert.equal(viewport.listeners.get("resize").length, 0);
  assert.equal(viewport.listeners.get("scroll").length, 0);
  for (let count = 0; count < 3; count++) {
    await ui.element("palette-toggle").click();
    assert.equal(viewport.listeners.get("resize").length, 1);
    assert.equal(viewport.listeners.get("scroll").length, 1);
    await ui.element("palette-close").click();
  }
});

test("without VisualViewport the palette keeps CSS sizing and search filtering", async () => {
  const ui = await loadDashboard();
  await ui.element("palette-toggle").click();
  assert.ok(!ui.element("palette").style.width);
  const search = ui.element("palette-search");
  search.value = "回答済み";
  await search.dispatch("input");
  assert.equal(ui.element("palette-count").textContent, "1 件");
  await ui.element("palette-list").querySelector("button").click();
  assert.equal(ui.element("answered").open, true);
  assert.equal(ui.element("palette").open, false);
});
