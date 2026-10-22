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

/**
 * 只声明必需的 `tools`。
 *
 * `commands` 不能写进 inject：cordis 的 inject 只认数组或「服务名→拦截配置」映射
 * （`cordis\lib\index.js:1491 resolve()`），写成 `{ required, optional }` 会被当成
 * 两个名叫 required / optional 的服务，插件永远卡在 pending。
 * 可选服务要用 `ctx.inject(['commands'], cb)` 子上下文挂。
 */
export const inject = ['tools'];
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
  // 用子上下文挂载，宿主没有 commands 服务时这段自然不执行，插件照旧工作。
  let commandCount = 0;
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (sub) => {
        const registered = registerCommands(sub, options);
        commandCount = registered.length;
        disposers.push(...registered);
        warn(`[dsh-lo-office] 已注册 ${registered.length} 个斜杠命令（/ppt-config、/ppt-status）`);
      });
    } catch (error) {
      warn(
        `[dsh-lo-office] 斜杠命令挂载失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
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
    `[dsh-lo-office] 已注册 ${definitions.length} 个工具（${names}）` +
      (commandCount > 0 ? `、${commandCount} 个斜杠命令` : '') +
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
