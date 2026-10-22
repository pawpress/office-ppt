/**
 * dsh-lo-office 的工具定义与执行器。
 *
 * 四个工具：
 *   lo_probe   —— 探测本机 LibreOffice / UNO 链路是否可用
 *   lo_build   —— UNO 直接建 deck，导出 odt/pptx/pdf/逐页 png
 *   lo_render  —— 把已有 pptx/pptx/odp 渲染成 pdf / 逐页 png
 *   lo_convert —— 任意格式互转（走 soffice --convert-to）
 *
 * 所有实际工作都在 python/lo_bridge.py，这里只做参数归一化 + 结果渲染。
 *
 * @module dsh-lo-office/tools
 */
import { isAbsolute, resolve } from 'node:path';
import { buildDeck, convertFile, probe, renderDeck } from './engine.js';

const LAYOUTS = [
  'cover',
  'section',
  'bullets',
  'statement',
  'quote',
  'table',
  'image',
  'image-left',
  'image-right',
  'closing',
];

const THEMES = ['light', 'dark', 'slate', 'warm', 'swiss'];

const slideProperties = {
  layout: { type: 'string', enum: LAYOUTS, description: '版式。缺省 bullets。' },
  title: { type: 'string', description: '页标题。cover 版式留空则用 deck 标题。' },
  subtitle: { type: 'string', description: '二级文本：cover 副标题 / section 说明 / closing 标语。' },
  kicker: { type: 'string', description: '标题上方小字标签。' },
  text: { type: 'string', description: 'statement / quote 版式的主文本。' },
  bullets: { type: 'array', items: { type: 'string' }, description: '要点列表。' },
  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '表格：首行为表头。' },
  image: { type: 'string', description: '图片绝对路径（png/jpg）。image 系列版式用。' },
  notes: { type: 'string', description: '备注（写入备注页）。' },
};

const buildResultSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    slideCount: { type: 'integer' },
    files: { type: 'object', additionalProperties: true },
    totalSeconds: { type: 'number' },
    error: { type: 'string' },
  },
};

function oneText(text) {
  return [{ type: 'text', text }];
}

/**
 * 结果对象 → 生成它时的会话工作目录。
 *
 * 不能用 `Object.defineProperty(result, '__cwd', ...)` 挂在返回值上：DSH 会校验
 * 工具返回值是否「lossless JSON」，非枚举自有属性在 JSON 往返后消失，直接被判不合法
 * （报错 value is not lossless JSON）。WeakMap 存在外面，返回值保持纯 JSON。
 */
const renderCwd = new WeakMap();

function asRecord(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

/** 相对路径按会话工作目录解析，绝对路径原样返回。 */
function resolveFrom(cwd, target) {
  if (typeof target !== 'string' || !target) return target;
  return isAbsolute(target) ? target : resolve(cwd, target);
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderBuild(value, cwd) {
  const result = asRecord(value);
  if (!result.ok) {
    return oneText(
      `❌ 生成失败\n\n${result.error ?? '未知错误'}` +
        (result.hint ? `\n\n提示：${result.hint}` : '') +
        (result.stderrTail ? `\n\n${String(result.stderrTail).slice(-800)}` : ''),
    );
  }
  const lines = [];
  lines.push(`✅ 用本机 LibreOffice 生成完成：${result.slideCount ?? '?'} 页，${result.totalSeconds ?? '?'} 秒`);
  lines.push(`主题 ${result.theme ?? '-'} · 比例 ${result.ratio ?? '-'}`);
  const files = asRecord(result.files);
  const bytes = asRecord(result.bytes);
  if (files.pptx) lines.push(`· PPTX  ${relative(cwd, files.pptx)}  ${humanBytes(bytes.pptx)}`);
  if (files.odp) lines.push(`· ODP   ${relative(cwd, files.odp)}  ${humanBytes(bytes.odp)}`);
  if (files.pdf) lines.push(`· PDF   ${relative(cwd, files.pdf)}  ${humanBytes(bytes.pdf)}`);
  if (Array.isArray(files.png) && files.png.length > 0) {
    lines.push(`· PNG   ${files.png.length} 张`);
    for (let index = 0; index < files.png.length; index += 1) {
      lines.push(`    ${index + 1}. ${relative(cwd, files.png[index])}`);
    }
  }
  const timings = asRecord(result.timings);
  if (timings.connect !== undefined) {
    lines.push(
      `阶段：连接 ${timings.connect}s · 排版 ${timings.build}s · 导出 ${timings.export}s`,
    );
  }
  if (result.autoFit === 'shrink') {
    const adjusted = Number(result.fitAdjusted) || 0;
    const overflow = Number(result.fitOverflow) || 0;
    if (adjusted > 0 || overflow > 0) {
      lines.push(
        `自动排版：${adjusted} 处文字缩小字号以适配文本框` +
          (overflow > 0 ? `；${overflow} 处缩到下限仍放不下，请缩短文案或减少条目` : ''),
      );
    } else {
      lines.push('自动排版：全部文字原字号即放得下');
    }
  }
  return oneText(lines.join('\n'));
}

function relative(cwd, target) {
  if (typeof target !== 'string') return String(target);
  if (!cwd) return target;
  const normalized = target.replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  // Windows 路径大小写不敏感：同一目录可能写成 D:\dsh1 和 d:\dsh1。
  const fold = process.platform === 'win32' ? (text) => text.toLowerCase() : (text) => text;
  if (fold(normalized).startsWith(`${fold(base)}/`)) return normalized.slice(base.length + 1);
  return normalized;
}

/**
 * 造四个工具的定义。
 *
 * @param {object} options 已归一化的插件配置（见 config.js 的 resolveOptions）：
 *   soffice / python / theme / ratio / formats / pngWidth / footer / pageNumbers /
 *   timeoutMs / keepWarm / idleMs。每一项都可以被单次工具调用的参数覆盖。
 */
export function buildLoTools(options = {}) {
  const defaults = {
    theme: options.theme ?? 'light',
    ratio: options.ratio ?? '16:9',
    formats: Array.isArray(options.formats) && options.formats.length > 0 ? options.formats : ['pptx', 'pdf', 'png'],
    pngWidth: Number.isFinite(options.pngWidth) ? options.pngWidth : 1600,
    pageNumbers: options.pageNumbers !== false,
    autoFit: options.autoFit === 'off' ? 'off' : 'shrink',
    minFontSize: Number.isFinite(options.minFontSize) ? options.minFontSize : 12,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 180_000,
  };
  // lo_render 只认 pdf/png 这类的再导出格式：从默认 formats 里挑出能渲染的，挑不出就退回 pdf+png。
  const renderDefaults = defaults.formats.filter((item) => item === 'pdf' || item === 'png');

  /** 每次调用都从配置出发，再用本次参数覆盖。 */
  const engineOptions = (signal, override = {}) => ({
    soffice: options.soffice || undefined,
    python: options.python || undefined,
    keepWarm: options.keepWarm,
    idleMs: options.idleMs,
    timeoutMs: override.timeoutMs ?? defaults.timeoutMs,
    signal,
  });

  return [
    {
      name: 'lo_probe',
      description:
        'Probe the local LibreOffice install and its UNO bridge: soffice path, version, bundled python, and whether a headless Impress document can actually be opened. Run this first if lo_build or lo_render report that LibreOffice is missing. 中文：探测本机 LibreOffice 与 UNO 桥是否可用（路径、版本、内置 python、能否真的开出无头 Impress 文档）。生成失败时先跑这个。',
      parameters: {
        type: 'object',
        properties: {
          soffice: {
            type: 'string',
            description: '指定 soffice.exe 路径（自动探测失败时用），缺省自动找。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const result = asRecord(value);
          if (!result.ok) {
            return oneText(
              `❌ 没找到可用的 LibreOffice\n\n${result.error ?? '未知错误'}\n\n` +
                '装一个 LibreOffice（Community 版即可），或设置环境变量 DSH_LO_SOFFICE 指向 soffice.exe。',
            );
          }
          const lines = [
            `✅ LibreOffice 可用`,
            `· 版本   ${result.version ?? '未知'}`,
            `· 程序   ${result.soffice}`,
            `· Python ${result.pythonVersion ?? '?'}  ${result.bundledPython ?? ''}`.trim(),
            `· UNO    ${result.uno ? '可导入' : '不可用'}`,
          ];
          if (result.live) {
            lines.push(`· 实开文档 通过（${result.livePages} 页，连接 ${result.connectSeconds}s）`);
          } else if (result.liveError) {
            lines.push(`· 实开文档 失败：${result.liveError}`);
          }
          return oneText(lines.join('\n'));
        },
      },
      async execute(rawArgs, exec) {
        const args = asRecord(rawArgs);
        exec?.signal?.throwIfAborted?.();
        const explicit = typeof args.soffice === 'string' && args.soffice ? args.soffice : undefined;
        return probe({
          deep: true,
          ...engineOptions(exec?.signal),
          soffice: explicit ?? (options.soffice || undefined),
        });
      },
    },
    {
      name: 'lo_build',
      description:
        'Build a deck by driving the locally installed LibreOffice over UNO (real Impress document, then export) — not a pure-JS writer. Give a deck title plus structured slides; get an editable PPTX (and optionally ODP, PDF, per-slide PNG). Supports layouts cover/section/bullets/statement/quote/table/image/image-left/image-right/closing, 5 themes, 16:9 or 4:3, tables, images and speaker notes. 中文：直接调本机 LibreOffice（UNO，真 Impress 文档）做 PPT，导出可编辑 PPTX / ODP / PDF / 逐页 PNG。先组织好真实内容再调用；生成后应打开图片检查版面。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Deck 标题，用于封面与默认文件名。' },
          slides: {
            type: 'array',
            items: { type: 'object', properties: slideProperties, additionalProperties: true },
            description: '幻灯片数组，按顺序渲染。',
          },
          theme: { type: 'string', enum: THEMES, description: '主题色板，默认 light。' },
          ratio: { type: 'string', enum: ['16:9', '4:3'], description: '画布比例，默认 16:9。' },
          footer: { type: 'string', description: '页脚文字，默认取设置里的页脚（出厂值 "office-ppt · 由本机 LibreOffice 生成"）。' },
          pageNumbers: { type: 'boolean', description: '是否显示页码，默认 true。' },
          outputDir: { type: 'string', description: '输出目录，缺省用会话工作目录。' },
          fileName: { type: 'string', description: '文件名主干（不含扩展名），缺省取标题。' },
          formats: {
            type: 'array',
            items: { type: 'string', enum: ['pptx', 'odp', 'pdf', 'png'] },
            description: '导出格式，默认 ["pptx","pdf","png"]。要逐页图就用 png。',
          },
          pngWidth: { type: 'integer', description: 'PNG 宽度像素，默认 1600。' },
          autoFit: {
            type: 'string',
            enum: ['off', 'shrink'],
            description: '自动排版：shrink（默认）用 LibreOffice 排版引擎量出文字所需高度，放不下就缩小字号；off 保持原字号。',
          },
          minFontSize: { type: 'integer', description: '自动排版最多缩到多少磅，默认 12。' },
          overwrite: { type: 'boolean', description: '覆盖同名旧文件，默认 true。' },
        },
        required: ['title', 'slides'],
        additionalProperties: false,
      },
      output: { schema: buildResultSchema, render: (_args, value) => renderBuild(value, renderCwd.get(value)) },
      async execute(rawArgs, exec) {
        const args = asRecord(rawArgs);
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
        exec?.signal?.throwIfAborted?.();
        const spec = {
          title: typeof args.title === 'string' ? args.title : '未命名演示',
          slides: Array.isArray(args.slides) ? args.slides : [],
          theme: typeof args.theme === 'string' ? args.theme : defaults.theme,
          ratio: typeof args.ratio === 'string' ? args.ratio : defaults.ratio,
          pageNumbers: typeof args.pageNumbers === 'boolean' ? args.pageNumbers : defaults.pageNumbers,
        };
        const footer = typeof args.footer === 'string' ? args.footer : options.footer;
        if (footer) spec.footer = footer;
        const result = await buildDeck(spec, {
          ...engineOptions(exec?.signal),
          outDir: resolveFrom(cwd, args.outputDir) ?? cwd,
          baseName: typeof args.fileName === 'string' ? args.fileName : undefined,
          formats:
            Array.isArray(args.formats) && args.formats.length > 0 ? args.formats : defaults.formats,
          pngWidth: Number.isFinite(args.pngWidth) ? args.pngWidth : defaults.pngWidth,
          autoFit: args.autoFit === 'off' || args.autoFit === 'shrink' ? args.autoFit : defaults.autoFit,
          minFontSize: Number.isFinite(args.minFontSize) ? args.minFontSize : defaults.minFontSize,
        });
        renderCwd.set(result, cwd);
        return result;
      },
    },
    {
      name: 'lo_render',
      description:
        'Render an existing PPTX/PPT/ODP into PDF and/or per-slide PNG by driving the locally installed LibreOffice. Use it to visually verify a deck you just produced. 中文：用本机 LibreOffice 把已有 PPTX/PPT/ODP 渲染成 PDF 和/或逐页 PNG，用来肉眼验收成品。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源文件路径（pptx/ppt/odp/fodp）。' },
          formats: {
            type: 'array',
            items: { type: 'string', enum: ['pdf', 'png', 'pptx', 'odp'] },
            description: '导出格式，默认 ["pdf","png"]。',
          },
          outputDir: { type: 'string', description: '输出目录，缺省放在源文件同目录的 rendered/ 下。' },
          pngWidth: { type: 'integer', description: 'PNG 宽度像素，默认 1600。' },
        },
        required: ['source'],
        additionalProperties: false,
      },
      output: { schema: buildResultSchema, render: (_args, value) => renderBuild(value, renderCwd.get(value)) },
      async execute(rawArgs, exec) {
        const args = asRecord(rawArgs);
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
        exec?.signal?.throwIfAborted?.();
        const source = resolveFrom(cwd, args.source);
        if (!source) return { ok: false, error: '缺少 source 参数' };
        const result = await renderDeck(source, {
          ...engineOptions(exec?.signal),
          outDir: resolveFrom(cwd, args.outputDir),
          formats:
            Array.isArray(args.formats) && args.formats.length > 0
              ? args.formats
              : renderDefaults.length > 0
                ? renderDefaults
                : ['pdf', 'png'],
          pngWidth: Number.isFinite(args.pngWidth) ? args.pngWidth : defaults.pngWidth,
        });
        renderCwd.set(result, cwd);
        return result;
      },
    },
    {
      name: 'lo_convert',
      description:
        'Convert a document with the locally installed LibreOffice (Word/Excel/PowerPoint.odt/ods/odp/docx/xlsx/pptx and PDF). Handy for docx→pdf or odt→docx. 中文：用本机 LibreOffice 做任意格式互转（docx/xlsx/pptx/odt/ods/odp/pdf 等）。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源文件路径。' },
          to: { type: 'string', description: '目标格式，如 pdf / docx / pptx / png。' },
          outputDir: { type: 'string', description: '输出目录，缺省为源文件同目录。' },
        },
        required: ['source', 'to'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => oneText(JSON.stringify(value, null, 2)) },
      async execute(rawArgs, exec) {
        const args = asRecord(rawArgs);
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
        exec?.signal?.throwIfAborted?.();
        const source = resolveFrom(cwd, args.source);
        if (!source) return { ok: false, error: '缺少 source 参数' };
        return convertFile(source, String(args.to ?? 'pdf'), {
          ...engineOptions(exec?.signal),
          outDir: resolveFrom(cwd, args.outputDir),
        });
      },
    },
  ];
}
