# Third-party notices — dsh-intelligent-ui

This package is vendored from **dsh-intelligent-ui**, written by
[cwd514](https://github.com/cwd514):

- Upstream: <https://github.com/cwd514/dsh-intelligent-ui>
- Upstream commit: `8d07542ffdbc2878e1037dd87e7b9ab79584578e` (2026-10-15), version 0.3.2
- License: MIT, Copyright (c) 2026 cwd514

## Changes in this copy

- `package.json` name: `@local/dsh-intelligent-ui` -> `dsh-intelligent-ui`, and the
  module id in `index.js`, `client.js`, `cordis.patch.yml` and `test/smoke.mjs`
  follows it. The dependency key therefore stays `dsh-intelligent-ui`, which is the
  key an earlier `github:cwd514/dsh-intelligent-ui` install recorded: upgrading
  replaces the GitHub spec with this bundled copy instead of adding a second plugin.
- `package.json` marked private, `files` trimmed to the runtime set, and
  `scripts` reduced to `check` and `test`.
- Upstream `docs/*.jpg` screenshots, `.github/` and `.gitignore` are not shipped.

Everything else (`index.js`, `client.js`, `catalog.md`, `icon.svg`, `locale/`,
`test/smoke.mjs`, the patch config comments) is upstream as-is.

## Upstream license text

```text
MIT License

Copyright (c) 2026 cwd514

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
