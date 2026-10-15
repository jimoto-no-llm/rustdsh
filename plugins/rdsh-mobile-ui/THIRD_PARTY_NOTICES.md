# Third-party notices — rdsh-mobile-ui

The phone-width rules in [`client.js`](client.js) are adapted from the mobile
rail of **Smart-DSH** (`dsh-notify-push/lib/client.js`, browser half), upstream
commit `86c34f43` (2026-10-09), written by
[hikarioyama](https://github.com/hikarioyama):

- Upstream: <https://github.com/hikarioyama/Smart-DSH>
- License: MIT, declared in that project's package manifests (it ships no root
  LICENSE file)

Only the responsive layout is taken. Smart-DSH's Web Push notifications,
Esc-to-stop, task hub, OpenCode Go catalogue and shared-HMR workaround are not
part of this package. Changes in this copy: the plugin's own
`data-rdsh-mobile-rail` attribute and `data-rdsh-mobile-ui` style marker (so
both bundles can be installed at once), a browser-host guard, the
`.pI_x6G_detailsCol` selector kept next to the current
`.pI_x6G_rightbarCol` name, and the host half and tests in this directory.

## Upstream license text

```text
MIT License

Copyright (c) the Smart-DSH authors
(https://github.com/hikarioyama/Smart-DSH)

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
