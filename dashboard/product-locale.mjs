// Resolve the dashboard's display language without changing environment or data.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export class ProductLocaleError extends Error {
  constructor(key, file, cause) {
    const labels = {
      "settings.read": "Cannot read rdsh language setting",
      "settings.invalid": "Invalid rdsh settings",
      "settings.language": "Invalid general.language in rdsh settings",
    };
    super(`${labels[key]}: ${file}`, cause ? { cause } : undefined);
    this.key = key;
    this.file = file;
  }
}

export function parseProductLocale(value) {
  const name = String(value)
    .trim()
    .split(/[.@]/, 1)[0]
    .replaceAll("_", "-")
    .toLowerCase();
  if (["en", "en-us", "en-gb"].includes(name)) return "en";
  if (
    ["zh", "zh-cn", "zh-sg", "chinese-simplified", "chinese-china"].includes(
      name,
    )
  )
    return "zh-CN";
  if (["ja", "ja-jp", "japanese", "japanese-japan"].includes(name)) return "ja";
  return null;
}

export function resolveProductLocale(
  explicit,
  setting = "auto",
  environment = process.env,
) {
  if (explicit !== undefined) return parseProductLocale(explicit) ?? "en";
  const preferred = environment.RDSH_LANG?.trim();
  if (preferred) return parseProductLocale(preferred) ?? "en";
  if (setting !== "auto") return parseProductLocale(setting) ?? "en";
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = environment[name]?.trim();
    if (value) return parseProductLocale(value) ?? "en";
  }
  return "en";
}

export async function loadProductLocale(explicit, environment = process.env) {
  const file = path.join(
    environment.DSH_HOME || path.join(homedir(), ".dsh"),
    "rdsh.json",
  );
  let settings;
  try {
    settings = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      return resolveProductLocale(explicit, "auto", environment);
    throw new ProductLocaleError("settings.read", file, error);
  }
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    (settings.general != null &&
      (typeof settings.general !== "object" || Array.isArray(settings.general)))
  ) {
    throw new ProductLocaleError("settings.invalid", file);
  }
  const setting = settings.general?.language ?? "auto";
  if (
    (Object.hasOwn(settings.general ?? {}, "language") &&
      settings.general.language == null) ||
    !["auto", "en", "zh-CN", "ja"].includes(setting)
  ) {
    throw new ProductLocaleError("settings.language", file);
  }
  return resolveProductLocale(explicit, setting, environment);
}
