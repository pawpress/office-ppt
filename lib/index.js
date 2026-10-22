/**
 * dsh-lo-office —— 让 DSH 直接驱动本机 LibreOffice（UNO）做 PPT 的插件。
 *
 * 和 dsh-ppt 的区别：dsh-ppt 用纯 JS 写 OOXML/HTML；这个插件起一个无头 soffice，
 * 用 UNO 真建 Impress 文档再导出，所以版式、字体度量、换行和 PDF/PNG 渲染
 * 都是 LibreOffice 自己的结果。
 *
 * `Config` 仍然导出：cordis 用它校验 apply 收到的配置，也让未来的客户端有机会
 * 读取 schema。但**DSH 桌面端（0.1.7）不渲染第三方插件的设置表单** ——
 * `dsh-settings` 自己写着「autoGenerate … 目前没有已发布的客户端这样做」。
 * 所以真正的改配置通道是 `lo_config` 工具，它直接改写 profile 的 cordis.patch.yml。
 *
 * @module dsh-lo-office
 */
import { Config, resolveOptions } from './config.js';
import { buildLoTools } from './tools.js';
import { stopAllWorkers } from './worker.js';

export { Config };

/** 不需要 skills 服务：工具是纯命令式的。 */
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
    `[dsh-lo-office] 已注册 ${disposers.length} 个工具（${names}），` +
      `主题 ${options.theme}、比例 ${options.ratio}、自动排版 ${options.autoFit}、` +
      `常驻 ${options.keepWarm ? '开' : '关'}`,
  );
}

export { buildLoTools } from './tools.js';
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
