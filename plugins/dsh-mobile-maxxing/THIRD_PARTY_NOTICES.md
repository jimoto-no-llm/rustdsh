# Third-party notices — dsh-mobile-maxxing

This bundle carries **dsh-mobile-maxxing**, a DSH Web UI mobile/PWA plugin,
vendored from the repository below:

- Upstream: <https://github.com/kuraneko1/dsh-mobile-maxxing>
- Upstream commit: `4c7c1d675cdf7e7e084ab77fb580d43ceb999162` (2026-11-06), version 1.0.4
  (upstream has not tagged or released v1.0.4 yet; this is the `release: v1.0.4` commit on `main`)
- License: MIT, Copyright (c) 2026 kuraneko1

## What ships

The repository is installed as one plugin (its root `cordis.patch.yml` and
`package.json` register `dsh-mobile-maxxing`). The two components it ships as
separate installable packages — `packages/dsh-locale-ja` and
`packages/dsh-md-rendering` — stay in the tree but are inert until someone adds
them the normal way; the bundle does not register them.

## Priority over the Smart-DSH layout

`plugins/rdsh-mobile-ui` (adapted from Smart-DSH) is also essential. The
installer attaches `dsh-mobile-maxxing` **after** `rdsh-mobile-ui`, so its
client module runs later: where both set a phone rule, `dsh-mobile-maxxing`
wins and the Smart-DSH-derived layout keeps only what it does not cover. To
keep the Smart-DSH layout alone, remove the bundle once:

```sh
dsh plugin --profile web remove dsh-mobile-maxxing
```

The removal does not survive `rdsh plugins install`, which re-attaches the
essential tier.

## Changes in this copy

- `packages/dsh-mobile-maxxing/docs/verification-20261027/` (acceptance
  screenshots) and `packages/dsh-mobile-maxxing/mockups/` are not shipped;
  they are review material, not runtime files.
- Markdown is cleaned where our markdownlint rules disagreed with the
  upstream files: three fenced blocks gained a `text` language, double
  blank lines were collapsed, one duplicate `#` heading was demoted, one
  bare URL was wrapped and one table separator was spaced. Wording is
  unchanged.
- Two CodeQL-driven fixes are carried over from the previous copy: the
  `<head>` lookup in `packages/dsh-mobile-maxxing/index.js` is a linear
  scan instead of an unanchored regex (polynomial backtracking), and four
  test files match `<script>` tags case-insensitively.

Apart from the changes above, everything else (`client.js`, `sw.js`,
`lib/`, `notify/`, `locale/`, `assets/`, the sub-packages and the root
documentation) is upstream as-is. Verify the installed copy with the
upstream repository when in doubt.

## Upstream license text

```text
MIT License

Copyright (c) 2026 kuraneko1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
