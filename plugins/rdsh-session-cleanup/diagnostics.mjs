import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const copy = {
  en: { runtime: 'Session cleanup requires the rdsh headless runtime with its asynchronous close-completion API.', failed: 'Headless session resource cleanup failed.' },
  ja: { runtime: 'セッションの後始末には、非同期の終了完了待機APIを備えたrdsh headlessランタイムが必要です。', failed: 'headlessセッションのリソースを後始末できませんでした。' },
  'zh-CN': { runtime: '会话清理需要提供异步关闭完成API的rdsh headless运行时。', failed: 'headless会话资源清理失败。' },
};

export function cleanupDiagnostic(key) {
  let language;
  try { language = JSON.parse(readFileSync(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rdsh.json'), 'utf8')).general?.language; }
  catch { /* Settings may not exist before the first launch. */ }
  if (typeof language !== 'string' || !Object.hasOwn(copy, language)) {
    const locale = [process.env.RDSH_LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]
      .find(value => value?.trim()) || Intl.DateTimeFormat().resolvedOptions().locale;
    language = locale.toLowerCase().startsWith('ja') ? 'ja' : locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  }
  return copy[language][key];
}
