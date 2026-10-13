# Skill acceptance procedure

Use this procedure on the official `@deepseek-ai/dsh` package version the user intends to support. A model session can cost money or use the user's configured provider, so run it only when the user has authorized that runtime test. Never copy credentials into a test record.

## 1. Install in an isolated DSH home

From a source checkout, set `DSH_HOME` to a newly created temporary directory and run `plugins/install-skills.sh`. Confirm that `$DSH_HOME/skills/rdsh-docs/SKILL.md` and its `references` directory exist. Keep the normal DSH home untouched.

Run `plugins/install-skills.sh` again with `FORCE=1`. Confirm that the previous `rdsh-docs` directory is preserved under `$DSH_HOME/skill-backups/rdsh-docs/`, which is outside the filesystem skill search root. Confirm that no `rdsh-docs.bak-*` or other backup directory appears in `$DSH_HOME/skills`.

## 2. Verify the `standard` preset

In a `web` session explicitly using `standard`:

1. Confirm that the model-facing catalog lists `rdsh-docs` and the `skill` tool is visible.
2. Send `/rdsh-docs`; confirm the session receives the full `skill_content` body and resource guidance.
3. In separate turns, use natural-language requests to check an installed DSH/rdsh feature, change a configuration, develop a plugin, and investigate a bug. For each, verify the model loads `rdsh-docs` and consults only the version-matched references needed.
4. Confirm the answer distinguishes documented capability, current configuration, successful execution, and unknown state. Do not treat a source description or file listing as successful runtime evidence.

## 3. Verify the `cordis` preset

In a `web` session explicitly using `cordis`, repeat the catalog and body-load checks. For a request that needs runtime facts, confirm the model uses `cordis_inspect_list` and a narrow `cordis_inspect_query` where available. Verify that it reports unavailable providers or state as unknown and that inspection is not described as executing a business method.

## 4. Verify preservation and reporting

Before and after the isolated test, compare only the test DSH home's directory names and the user's settings-file hashes; do not print settings contents. Confirm that the normal user profile, preset, skills, and authentication files were not changed. Record the DSH version, `web` profile, selected preset, catalog visibility, body-load result, natural-language selection results, references read, and unresolved checks. Keep any item that could not be observed explicitly unverified.

`rdsh skills`, `rdsh profiles`, frontmatter parsing, and unit tests can support installer or file-format checks. None of them alone satisfies the model-runtime acceptance above.
