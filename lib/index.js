/**
 * dsh-lo-office —— 让 DSH 直接驱动本机 LibreOffice（UNO）做 PPT 的插件。
 *
 * 和 dsh-ppt 的区别：dsh-ppt 用纯 JS 写 OOXML/HTML；这个插件起一个无头 soffice，
 * 用 UNO 真建 Impress 文档再导出，所以版式、字体度量、换行和 PDF/PNG 渲染
 * 都是 LibreOffice 自己的结果。
 *
 * @module dsh-lo-office
 */
import { buildLoTools } from './tools.js';

/** 不需要 skills 服务：工具是纯命令式的。 */
export const inject = ['tools'];
export const name = 'dsh-lo-office';

export function apply(ctx, config = {}) {
  const warn = (message) => {
    ctx.logger?.warn?.(message);
  };
  const disposers = [];

  for (const definition of buildLoTools()) {
    try {
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      warn(`[dsh-lo-office] 工具 ${definition.name} 注册失败：${error instanceof Error ? error.message : String(error)}`);
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
    });
  }

  warn(`[dsh-lo-office] 已注册 ${disposers.length} 个工具（lo_probe / lo_build / lo_render / lo_convert）`);
}

export { buildLoTools } from './tools.js';
export { buildDeck, convertFile, findPython, findSoffice, probe, renderDeck } from './engine.js';
