/**
 * dsh-lo-office —— 斜杠命令。
 *
 * `ctx.commands.register()` 注册的命令**只对用户生效**，不产生模型消息：
 * 用户在输入框敲 `/ppt-config theme=swiss` 就直接执行，不消耗 token，
 * 也不需要模型在场。这才是「指令类型」的正确形态。
 *
 * 语法（`rawInput` 归命令自己解析）：
 *   /ppt-config                      查看全部配置
 *   /ppt-config theme=swiss          改一项
 *   /ppt-config theme=swiss autoFit=off
 *   /ppt-config formats=pptx,pdf
 *   /ppt-config reset                恢复出厂
 *   /ppt-status                      探测 LibreOffice 是否可用
 *
 * @module dsh-lo-office/commands
 */
import { DEFAULTS, resolveOptions } from './config.js';
import { probe } from './engine.js';
import {
  EDITABLE,
  coerceField,
  describeConfig,
  findProfileDir,
  readStoredConfig,
  writeStoredConfig,
} from './store.js';

const ok = (text) => ({ kind: 'success', text });
const bad = (text) => ({ kind: 'error', text });

function usage() {
  return [
    '用法：',
    '  /ppt-config                      查看全部配置',
    '  /ppt-config theme=swiss          改一项',
    '  /ppt-config theme=swiss autoFit=off',
    '  /ppt-config formats=pptx,pdf     数组用逗号',
    '  /ppt-config reset                恢复出厂',
    '',
    `可改字段：${EDITABLE.join('、')}`,
  ].join('\n');
}

/**
 * 解析 `key=value key=value` 形式。
 *
 * value 里可能有逗号（formats）也可能有空格（footer），所以用引号包住：
 *   footer="由 LibreOffice 生成"
 */
export function parseAssignments(rawInput) {
  const text = String(rawInput ?? '').trim();
  if (text === '') return { pairs: [], rest: '' };
  if (text === 'reset' || text === '--reset') return { reset: true, pairs: [] };

  const pairs = [];
  const pattern = /([A-Za-z][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    pairs.push([key, value]);
    match = pattern.exec(text);
  }
  return { pairs, rest: text.replace(pattern, '').trim() };
}

/** 把当前生效的配置读出来（patch 打底 + 内存覆盖）。 */
async function currentConfig(options) {
  const current = { ...DEFAULTS };
  try {
    const stored = await readStoredConfig(findProfileDir());
    if (stored) Object.assign(current, stored);
  } catch {
    /* 读不到就当没存过 */
  }
  Object.assign(current, options);
  return current;
}

async function configHandler({ rawInput }) {
  const parsed = parseAssignments(rawInput);

  if (parsed.reset) {
    const profileDir = findProfileDir();
    try {
      await writeStoredConfig(profileDir, {});
    } catch (error) {
      return bad(`写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return ok(
      [
        '✅ 已恢复出厂配置',
        '',
        describeConfig({ ...DEFAULTS }),
        '',
        '⚠️ 重启 Desktop 后完全生效（本进程仍用旧值，直到 profile 重载）。',
      ].join('\n'),
    );
  }

  if (parsed.pairs.length === 0) {
    const current = await currentConfig(currentConfigOptions);
    const patch = findProfileDir();
    return ok(
      [
        '⚙️ 当前配置',
        '',
        describeConfig(current),
        '',
        patch ? `磁盘：${patch}\\cordis.patch.yml` : '⚠️ 没定位到 profile，只改了内存',
        '',
        '改法：/ppt-config theme=swiss autoFit=off',
      ].join('\n'),
    );
  }

  // ---- 有参数：逐项校验
  const errors = [];
  const applied = [];
  const target = {};
  for (const [key, value] of parsed.pairs) {
    const checked = coerceField(key, value);
    if (!checked.ok) {
      errors.push(`  ${key} → ${checked.error}`);
      continue;
    }
    target[key] = checked.value;
    applied.push(`${key}=${Array.isArray(checked.value) ? checked.value.join(',') : checked.value}`);
  }
  if (errors.length > 0) {
    return bad(['❌ 有字段没通过校验：', ...errors, '', usage()].join('\n'));
  }

  // 只写差异，其余字段保持 patch 里已有的值
  const merged = { ...DEFAULTS };
  try {
    const stored = await readStoredConfig(findProfileDir());
    if (stored) Object.assign(merged, stored);
  } catch {
    /* 忽略 */
  }
  Object.assign(merged, target);

  const toPersist = {};
  for (const key of EDITABLE) {
    const value = merged[key];
    const fallback = DEFAULTS[key];
    const same = Array.isArray(value)
      ? Array.isArray(fallback) && value.join('\u0000') === fallback.join('\u0000')
      : value === fallback;
    if (!same) toPersist[key] = value;
  }

  let patchPath = null;
  try {
    const written = await writeStoredConfig(findProfileDir(), toPersist);
    patchPath = written.path;
  } catch (error) {
    return bad(`校验通过但写入失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const lines = ['✅ 已写入配置', '', ...applied.map((item) => `  ${item}`), ''];
  lines.push(patchPath ? `磁盘：${patchPath}` : '（未定位到 profile）');
  lines.push('');
  lines.push('⚠️ 重启 Desktop 后生效（本进程仍用旧值，直到 profile 重载）。');
  lines.push('要立刻生效，让模型调用 lo_config 改内存里的那份。');
  return ok(lines.join('\n'));
}

async function statusHandler() {
  const result = await probe({ deep: true });
  if (!result.ok) {
    return bad(`❌ 探测失败：${result.error ?? '未知错误'}`);
  }
  const lines = [
    '✅ LibreOffice 可用',
    '',
    `  版本   ${result.version ?? '未知'}`,
    `  程序   ${result.soffice}`,
    `  Python ${result.pythonVersion ?? '?'}`,
    `  UNO    ${result.uno ? '可导入' : '不可用'}`,
  ];
  if (result.live) {
    lines.push(`  实开文档 通过（${result.livePages} 页，连接 ${result.connectSeconds}s）`);
  } else if (result.liveError) {
    lines.push(`  实开文档 失败：${result.liveError}`);
  }
  return ok(lines.join('\n'));
}

/** 供 handler 读取「当前进程生效的配置」。 */
let currentConfigOptions = {};

/**
 * 注册斜杠命令。
 *
 * @param {object} ctx     cordis 上下文（需带 commands 服务）
 * @param {object} options 当前生效的插件配置
 * @returns {Function[]}   取消注册的函数
 */
export function registerCommands(ctx, options) {
  currentConfigOptions = resolveOptions(options);
  const disposers = [];

  const definitions = [
    {
      name: 'ppt-config',
      description: '查看或修改 office-ppt 插件配置（主题 / 比例 / 自动排版 / 导出格式等）',
      input: { hint: 'theme=swiss autoFit=off │ reset │ 留空查看' },
      handler: configHandler,
    },
    {
      name: 'ppt-status',
      description: '探测本机 LibreOffice 与 UNO 桥是否可用',
      handler: statusHandler,
    },
  ];

  for (const definition of definitions) {
    try {
      const dispose = ctx.commands.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-lo-office] 命令 ${definition.name} 注册失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return disposers;
}
