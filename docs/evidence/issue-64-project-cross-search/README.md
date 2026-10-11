# Issue #64 project cross-search UI evidence

The screenshots use temporary synthetic projects created by
[`tests/e2e/project-overview.mjs`](../../../tests/e2e/project-overview.mjs).
The before image is the existing single-project dashboard. The after image
shows four matching record kinds from one explicitly included project. The
browser test also verifies that an unlisted project and artifact body text do
not appear, that the decision link has no browser key, and that it opens the
matching decision card in the source dashboard.

Reproduce with:

```powershell
$env:RDSH_PROJECT_OVERVIEW_SCREENSHOT_DIR = '../../docs/evidence/issue-64-project-cross-search'
node project-overview.mjs
```

Run the command from `tests/e2e` after installing the E2E dependencies.
