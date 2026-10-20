/**
 * Host half of the rdsh no-feedback bundle.
 *
 * This package carries only `cordis.patch.yml`: the loader applies the bundle's
 * patch layer and the three `disabled: true` rows turn the DSH feedback surface
 * off. There is no host behavior to install, and no client half to load, so this
 * module exists purely so the package resolves as a plugin bundle entry.
 */
export function apply() {}
