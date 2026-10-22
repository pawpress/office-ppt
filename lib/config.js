/**
 * dsh-lo-office —— 插件配置（DSH 设置面板里可改的那些字段）。
 *
 * DSH 的设置表单是从插件导出的 Config schema 自动派生的：只有标了 `.volatile()`
 * 的字段才会出现在表单里，改完写回当前 profile 的 patch，不用重启就能生效。
 *
 * schemastery 拿不到时（比如被裁剪过的安装）退回「无 schema」：cordis 的
 * resolveConfig 看到 runtime.Config 不存在就直接放行原始配置，插件照旧工作，
 * 只是设置面板里没有这一页。
 *
 * @module dsh-lo-office/config
 */

export const THEMES = ['light', 'dark', 'slate', 'warm', 'swiss'];
export const RATIOS = ['16:9', '4:3'];
export const FORMATS = ['pptx', 'odp', 'pdf', 'png'];

export const DEFAULTS = Object.freeze({
  soffice: '',
  python: '',
  theme: 'light',
  ratio: '16:9',
  formats: Object.freeze(['pptx', 'pdf', 'png']),
  pngWidth: 1600,
  footer: 'office-ppt · 由本机 LibreOffice 生成',
  pageNumbers: true,
  timeoutMs: 240_000,
  keepWarm: true,
  idleMs: 60_000,
});

let z = null;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  z = null;
}

function buildConfig() {
  if (!z) return undefined;
  return z.object({
    soffice: z
      .string()
      .default(DEFAULTS.soffice)
      .description('soffice.exe 的完整路径；留空则自动探测（注册表 → 常见安装位置 → 环境变量）。')
      .volatile(),
    python: z
      .string()
      .default(DEFAULTS.python)
      .description('带 uno 模块的 python 解释器；留空则用 LibreOffice 自带的那个。')
      .volatile(),
    theme: z
      .union(THEMES.map((name) => z.const(name)))
      .default(DEFAULTS.theme)
      .description('默认主题色板。')
      .volatile(),
    ratio: z
      .union(RATIOS.map((name) => z.const(name)))
      .default(DEFAULTS.ratio)
      .description('默认画布比例。')
      .volatile(),
    formats: z
      .array(z.union(FORMATS.map((name) => z.const(name))))
      .default([...DEFAULTS.formats])
      .description('默认导出格式。')
      .volatile(),
    pngWidth: z
      .natural()
      .min(320)
      .max(3840)
      .default(DEFAULTS.pngWidth)
      .description('逐页 PNG 的目标宽度（像素）。')
      .volatile(),
    footer: z
      .string()
      .default(DEFAULTS.footer)
      .description('默认页脚文字；给空字符串则不画页脚。')
      .volatile(),
    pageNumbers: z
      .boolean()
      .default(DEFAULTS.pageNumbers)
      .description('默认是否在页脚显示页码。')
      .volatile(),
    timeoutMs: z
      .natural()
      .min(5_000)
      .max(900_000)
      .default(DEFAULTS.timeoutMs)
      .description('单次调用的超时毫秒数。')
      .volatile(),
    keepWarm: z
      .boolean()
      .default(DEFAULTS.keepWarm)
      .description('复用常驻的 soffice 进程，省掉每次约 0.5 秒的冷启动。')
      .volatile(),
    idleMs: z
      .natural()
      .min(1_000)
      .max(1_800_000)
      .default(DEFAULTS.idleMs)
      .description('常驻进程空闲多久后回收（毫秒）。')
      .volatile(),
  });
}

/** 插件配置 schema；schemastery 不可用时为 undefined（设置面板里就没有这一页）。 */
export const Config = buildConfig();

/**
 * 读一个配置字段的当前值。
 *
 * 标了 `.volatile()` 的字段经过 cordis 校验后交到 apply 手里的是 `{ get() }` 容器
 * （见 dsh-bash-local\lib\index.js:52 的 `config.timeoutMs.get()`），不是裸值 ——
 * 设置面板改了之后每次 get() 才读到新的。没标 volatile 或 schema 缺失时是裸值。
 */
function read(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

function pickOneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function pickPath(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function pickNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 页脚特殊：空字符串是合法值（表示不画页脚），只有非字符串才回落默认。 */
function pickFooter(value) {
  return typeof value === 'string' ? value : DEFAULTS.footer;
}

/**
 * 把用户配置归一化成引擎/工具层直接可用的选项。
 *
 * schema 校验只在 cordis 装载时跑一次；这里再做一遍纯函数式的兜底，因为：
 *   - schemastery 缺失时根本没有校验；
 *   - 老 profile 里可能留着非法值（比如早期手写的 patch）。
 */
export function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const readFormats = read(raw.formats);
  const formats = Array.isArray(readFormats) ? readFormats.filter((item) => FORMATS.includes(item)) : [];

  return {
    soffice: pickPath(read(raw.soffice), DEFAULTS.soffice) || undefined,
    python: pickPath(read(raw.python), DEFAULTS.python) || undefined,
    theme: pickOneOf(read(raw.theme), THEMES, DEFAULTS.theme),
    ratio: pickOneOf(read(raw.ratio), RATIOS, DEFAULTS.ratio),
    formats: formats.length > 0 ? formats : [...DEFAULTS.formats],
    pngWidth: pickNumber(read(raw.pngWidth), DEFAULTS.pngWidth, 320, 3840),
    footer: pickFooter(read(raw.footer)),
    pageNumbers: read(raw.pageNumbers) !== false,
    timeoutMs: pickNumber(read(raw.timeoutMs), DEFAULTS.timeoutMs, 5_000, 900_000),
    keepWarm: read(raw.keepWarm) !== false,
    idleMs: pickNumber(read(raw.idleMs), DEFAULTS.idleMs, 1_000, 1_800_000),
  };
}
