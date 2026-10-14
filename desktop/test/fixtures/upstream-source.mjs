import { PATCH_PATHS } from '../../overlay.mjs';

export const source = {
    [PATCH_PATHS[0]]: `const appId = resolveDesktopAppId(env)\nconst policy = packagesMacOS && unsigned ? undefined : resolveDesktopPolicyEnvironment(env)\nconst update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)\nconst buildVersion = resolveDesktopBuildVersion(env, productVersion)\nprotocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }]\ndshDesktopAppId: appId,\nproductName: 'DeepSeek Harness'\nartifactName: \`deepseek-harness-\n'lib/main.js',\nextraResources: [\nsignIgnore: [\nchannel: 'nightly'`,
    [PATCH_PATHS[1]]: `if (updater === autoUpdater) {\nthis.updater.channel = 'nightly'\nthis.updater.allowPrerelease = true`,
    [PATCH_PATHS[2]]: `app.setAsDefaultProtocolClient('dsh')\nurl === 'dsh://open' || url === 'dsh://open/'\napplicationName: 'DeepSeek Harness'`,
    [PATCH_PATHS[3]]: `const CHANNEL = 'nightly'`,
    [PATCH_PATHS[4]]: `export function validateDesktopBuildVersion(buildVersion, productVersion) {\n}\nexport function resolveDesktopBuildVersion(env, productVersion) {\n}\nexport function desktopBuildVersionPrefix(productVersion) {\n}`,
    [PATCH_PATHS[5]]: `set -e\nexec "$resources/../MacOS/DeepSeek Harness"`,
    [PATCH_PATHS[6]]: 'setlocal DisableDelayedExpansion\r\nDeepSeek Harness.exe',
    [PATCH_PATHS[7]]: "CSC_IDENTITY_AUTO_DISCOVERY: 'false',\nconst environment = target.platform === 'darwin' && invocation.unsigned\nconst filename = `deepseek-harness-${buildVersion}\n'DeepSeek Harness.app'",
    [PATCH_PATHS[8]]: "'DeepSeek Harness.app'\n'DeepSeek Harness.exe'\n'DeepSeek Harness'",
    [PATCH_PATHS[9]]: "DSH_DESKTOP_APP_ID: 'com.deepseek.harness'\nif (target.platform !== 'darwin' || !options.unsigned) resolveDesktopPolicyEnvironment(environment)",
    [PATCH_PATHS[10]]: "'DeepSeek Harness.app'\nconst base = `deepseek-harness-${version}",
  };
