# render_ui — element catalog

One call renders one view. Blocks render top to bottom in the order you write them, and the user sees the view rather than your JSON. Your prose reply stays the primary answer: state the conclusion in text, and let the view carry the structure and the detail.

Top level: `{ title?, summary?, blocks: [ ... ] }`

- `title` — short heading above the view. Omit it when the view needs no heading.
- `summary` — one line under the title. Write the takeaway, not a table of contents.
- `blocks` — 1 to 40 blocks. `section`, `row`, and `tabs` nest further blocks, up to 6 levels deep.

## Layout

- `section` — `{ title?, subtitle?, blocks }`. A titled group. Use it to divide a long view.
- `row` — `{ blocks }`. Two to four blocks side by side; wraps to one column when narrow. Use it for a group of `stat` blocks or two paired cards.
- `text` — `{ text, style? }`. `style` is `body` (default), `lead` (one emphasized sentence), or `caption` (small and muted).
- `callout` — `{ tone, title?, text }`. `tone` is `info`, `success`, `warn`, or `error`. Reserve it for the conclusion, a risk, or a next step — not for ordinary sentences.
- `divider` — `{}`. A thin rule between groups.
- `stat` — `{ label, value, delta?, hint? }`. One number that matters. `delta` is a short comparison such as `+12% vs last year`; `hint` is a caption.

## Data

- `table` — `{ columns: [{ key, label, align?, format? }], rows: [{ <key>: value }], sortable?, initialSort?, title? }`.
  `align` is `left` (default), `right`, or `center`; use `right` for numbers. `format` is `text`, `number`, or `percent`, where `percent` reads the cell as a fraction: `0.42` shows as `42%`. `sortable` defaults to false. `initialSort` is `{ key, dir: "asc" | "desc" }`. Up to 100 rows: show the rows that carry the answer instead of dumping a dataset. Every row cell must use a column `key`; a missing cell renders blank.
- `chart` — `{ kind, categories, series: [{ label, data, color? }], stacked?, yLabel?, title? }`.
  `kind` is `bar`, `line`, or `pie`. `categories` are the x-axis labels (or the slice labels for `pie`), and every series `data` holds exactly one number per category. `pie` takes exactly one series. Omit `color` and the view picks from the theme; a `color` is a theme token name such as `--dsw-alias-brand-primary`.
- `comparison` — `{ columns: [{ label, hint? }], rows: [{ attribute, values }], title? }`. Options side by side. Each row's `values` holds one cell per column, in column order. Prefer it over `table` when the user is choosing between a few options.
- `timeline` — `{ items: [{ label, detail?, at? }], title? }`. Ordered steps, phases, or history. `at` is a short time label.
- `diagram` — `{ nodes: [{ id, label, detail?, group? }], edges: [{ from, to, label? }], layout?, title? }`. `layout` is `flow` (default), `tree`, or `cycle`. Every `id` must be unique and every edge must reference existing ids. Selecting a node reveals its `detail`. Nodes in the same `group` share a color.
- `tabs` — `{ tabs: [{ label, blocks }] }`. Use it when one question has two to four parallel answers, such as detail per environment or per plan. When everything should be visible at once, use `section` instead.

## Interaction

- `inputs` — `{ fields, title?, submit? }`. Declares named inputs the user can change. `submit` is `{ label, message }`: pressing it sends `message` to you as the user's next message, with each `{{name}}` replaced by the current value of input `name` — a `select` contributes its option's `label`, not its `value`.
- `calc` — `{ label, expr, format?, hint? }`. A value recomputed in the browser whenever an input changes. `format` is `{ prefix?, suffix?, decimals?, percent? }`.
- `buttons` — `{ buttons: [{ label, message?, open?, style? }] }`. `style` is `primary` or `default`. Each button carries exactly one of `message` (send it to you) or `open` (open that file path). Two to four buttons.

## Input fields

`{ name, label, kind, value?, min?, max?, step?, options?, placeholder?, hint? }`

`name` is an identifier (`[A-Za-z_][A-Za-z0-9_]*`) that `calc` expressions and `{{name}}` placeholders refer to.

- `text`, `textarea` — `value` is the initial string.
- `number`, `range` — `min`, `max`, `step`, and a numeric `value`. `range` requires both `min` and `max`.
- `select` — `options: [{ value, label }]` is required, and `value` is the initially selected option.
- `checkbox` — a boolean `value`.

## calc expressions

Operands are numbers, `"strings"`, and the names of declared inputs.
Operators are `+ - * / %`, comparisons, `&& || !`, `?:`, and parentheses.
Functions are `min max sum avg round floor ceil abs sqrt pow if`.
A name is the input's raw value, so a `select` compares against its option `value` (`plan == 'pro'`) while `{{plan}}` in a message shows the option `label`.
There is no property access and no other function. Anything that cannot be computed renders as `—`, so guard against zero divisors and empty inputs.

## Examples

A choice between options:

```json
{ "title": "プラン比較", "summary": "3年運用なら B が安い", "blocks": [
  { "type": "comparison", "columns": [{ "label": "A 従量" }, { "label": "B 固定" }],
    "rows": [
      { "attribute": "月額", "values": ["¥3/回", "¥12,000"] },
      { "attribute": "3年総額 (月5,000回)", "values": ["¥540,000", "¥432,000"] } ] },
  { "type": "callout", "tone": "info", "text": "月2,000回を下回るなら A が有利です。" },
  { "type": "buttons", "buttons": [
      { "label": "B で見積書を作る", "message": "プランBで3年分の見積書を作って", "style": "primary" } ] } ] }
```

A small calculator that hands the user's numbers back to you:

```json
{ "title": "月額コスト試算", "blocks": [
  { "type": "inputs", "fields": [
      { "name": "calls", "label": "月間コール数", "kind": "range", "min": 0, "max": 20000, "step": 500, "value": 5000 },
      { "name": "plan", "label": "プラン", "kind": "select", "value": "b",
        "options": [{ "value": "a", "label": "A 従量" }, { "value": "b", "label": "B 固定" }] } ],
    "submit": { "label": "この条件で相談する", "message": "月{{calls}}コール・プラン{{plan}}で見積もって" } },
  { "type": "calc", "label": "月額", "expr": "if(plan == 'b', 12000, calls * 3)",
    "format": { "prefix": "¥", "decimals": 0 } } ] }
```

A trend with the numbers behind it:

```json
{ "blocks": [
  { "type": "chart", "kind": "bar", "title": "四半期売上", "yLabel": "百万円",
    "categories": ["Q1", "Q2", "Q3", "Q4"],
    "series": [{ "label": "2026", "data": [120, 138, 151, 174] },
               { "label": "2025", "data": [98, 112, 121, 133] }] },
  { "type": "table", "sortable": true, "columns": [
      { "key": "quarter", "label": "四半期" },
      { "key": "yoy", "label": "前年比", "align": "right", "format": "percent" }],
    "rows": [{ "quarter": "Q1", "yoy": 0.22 }, { "quarter": "Q2", "yoy": 0.23 }] } ] }
```

## Do and don't

- Do lead with the conclusion in prose, and let the view show the evidence.
- Do keep one view per answer; a second `render_ui` call is worth it only for a genuinely different question.
- Don't restate the view's contents in text, and don't decorate an answer that one sentence already carries.
- Don't use it when the user needs something to copy verbatim, or when the work is a code change or a file edit.
- Don't let numbers disagree with what you computed or read elsewhere; the view is not a place to round differently.
