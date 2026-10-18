import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../plugins/rdsh-settings/assets/ui-controls.css', import.meta.url),
  'utf8',
);

// DSH 0.2.0-rc.2 renders a previewable markdown image as
//   <button class="_imageButton_<hash>_<line>"><img class="_image_<hash>_<line>"></button>
// with the wrapper at display:inline-block. A figure that shares a line with
// text is then squeezed into the leftover width and the surrounding paragraph
// wraps around it. The shared stylesheet is injected into the DSH Web UI, so it
// has to make that wrapper behave like every other answer image.

function ruleFor(selector) {
  const pattern = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
  );
  const match = css.match(pattern);
  assert.ok(match, `missing rule: ${selector}`);
  return match[1];
}

test('the answer image wrapper is a block, not an inline box', () => {
  // The wrapper is a <button>; the element qualifier keeps this above DSH's own
  // ._imageButton_* { display: inline-block } whatever the sheet order is.
  const wrapper = ruleFor('button[class*="imageButton"]');
  assert.match(wrapper, /display:\s*block/);
  assert.match(wrapper, /max-width:\s*100%/);
});

test('the wrapped image may use the answer column', () => {
  const image = ruleFor('button[class*="imageButton"] img[class*="image_"]');
  assert.match(image, /max-width:\s*100%/);
  assert.match(image, /max-height:/);
});

test('the override stays scoped to DSH image wrappers', () => {
  assert.doesNotMatch(css, /^\s*img\s*\{/m, 'a bare img selector would change the dashboard and setup pages');
  assert.doesNotMatch(css, /!important/, 'the override must win on specificity, not on !important');
});
