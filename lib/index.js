/**
 * dsh-lo-office —— 让 DSH 直接驱动本机 LibreOffice（UNO）做 PPT 的插件。
 *
 * 和 dsh-ppt 的区别：dsh-ppt 用纯 JS 写 OOXML/HTML；这个插件起一个无头 soffice，
 * 用 UNO 真建 Impress 文档再导出，所以版式、字体度量、换行和 PDF/PNG 渲染
 * 都是 LibreOffice 自己的结果。
 *
 * 三种入口的分工：
 *   - **斜杠命令** `/ppt-config`、`/ppt-status` —— 你自己在输入框敲，不走模型、不花 token。
 *   - **工具** `lo_build` 等 —— 模型调用，做实际生成。
 *   - **Config schema** —— 装载时校验配置，同时是字段清单的单一真相源
 *     （DSH 桌面端不渲染第三方插件的设置表单，所以别指望它变成 UI）。
 *
 * @module dsh-lo-office
 */
import { registerCommands } from './commands.js';
import { Config, resolveOptions } from './config.js';
import { buildLoTools } from './tools.js';
import { stopAllWorkers } from './worker.js';

export { Config };

/** tools 必须有；commands 可选 —— 老宿主没有命令面就跳过斜杠命令。 */
export const inject = {
  required: ['tools'],
  optional: ['commands'],
};
export const name = 'dsh-lo-office';

export function apply(ctx, config = {}) {
  const warn = (message) => {
    ctx.logger?.warn?.(message);
  };
  const options = resolveOptions(config);
  const disposers = [];
  const definitions = buildLoTools(options);

  for (const definition of definitions) {
    try {
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      warn(
        `[dsh-lo-office] 工具 ${definition.name} 注册失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 斜杠命令：只对用户生效，不产生模型消息。
  const commands = [];
  if (ctx.commands && typeof ctx.commands.register === 'function') {
    try {
      commands.push(...registerCommands(ctx, options));
    } catch (error) {
      warn(
        `[dsh-lo-office] 斜杠命令注册失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    warn('[dsh-lo-office] 宿主没有 commands 服务，/ppt-config 与 /ppt-status 不可用');
  }

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of [...disposers, ...commands]) {
        try {
          dispose();
        } catch {
          /* 已经卸载 */
        }
      }
      // 常驻的 soffice 子进程必须跟着插件一起收掉，否则会留下孤儿进程。
      Promise.resolve(stopAllWorkers()).catch(() => {});
    });
  }

  const names = definitions.map((definition) => definition.name).join(' / ');
  warn(
    `[dsh-lo-office] 已注册 ${disposers.length} 个工具（${names}）` +
      (commands.length > 0 ? `、${commands.length} 个斜杠命令（/ppt-config、/ppt-status）` : '') +
      `，主题 ${options.theme}、比例 ${options.ratio}、自动排版 ${options.autoFit}、` +
      `常驻 ${options.keepWarm ? '开' : '关'}`,
  );
}

export { buildLoTools } from './tools.js';
export { parseAssignments, registerCommands } from './commands.js';
export { buildDeck, convertFile, findPython, findSoffice, probe, renderDeck } from './engine.js';
export {
  EDITABLE,
  ENTRY_ID,
  coerceField,
  findProfileDir,
  parseEntryConfig,
  readStoredConfig,
  renderEntry,
  replaceEntry,
  writeStoredConfig,
} from './store.js';
