/**
 * dsh-lo-office —— 配置的读写与持久化。
 *
 * DSH 桌面端（0.1.7）**不会**把插件的 Config schema 自动渲染成设置表单：
 * `dsh-settings` 里那句 “autoGenerate … 目前没有已发布的客户端这样做” 说的就是它。
 * 想改配置只能走命令，所以这里提供真正可用的读写通道：
 *
 *   读 —— 从当前 apply(ctx, config) 拿到的配置 + 落盘的 patch 合并
 *   写 —— 改写 profile 的 cordis.patch.yml 里本插件条目，再让 DSH 重新加载
 *
 * 为什么不写 `cordis.yml`：那是启动时由 bundles + patch 组合出来的**生成物**，
 * 手改会被下次组合覆盖（实测被写回 `[]`）。
 *
 * @module dsh-lo-office/store
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { AUTOFITS, DEFAULTS, FORMATS, RATIOS, THEMES } from './config.js';

/** 本插件在 patch 里的条目 id，和 cordis.patch.yml 保持一致。 */
export const ENTRY_ID = 'dsh-lo-office';

export { DEFAULTS };

/** 可以在运行时修改的字段（与 Config schema 一一对应）。 */
export const EDITABLE = [
  'soffice',
  'python',
  'theme',
  'ratio',
  'formats',
  'pngWidth',
  'footer',
  'pageNumbers',
  'autoFit',
  'minFontSize',
  'timeoutMs',
  'keepWarm',
  'idleMs',
];

/**
 * 定位当前 profile 目录。
 *
 * DSH 的进程环境里带 DSH_PROFILE_DIR；没有的话从 cwd 往上找 `.dsh/profiles/<name>`，
 * 再退到常见的 `.dsh` 位置。找不到返回 null（此时只改内存、不落盘）。
 */
export function findProfileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR;
  if (fromEnv && existsSync(join(fromEnv, 'package.json'))) return resolve(fromEnv);

  const home = process.env.DSH_HOME;
  if (home) {
    const profiles = join(home, 'profiles');
    if (existsSync(profiles)) return resolve(profiles, process.env.DSH_PROFILE ?? 'desktop');
  }

  for (const candidate of ['D:\\.dsh', join(process.env.USERPROFILE ?? '', '.dsh')]) {
    if (!candidate) continue;
    const profile = join(candidate, 'profiles', 'desktop');
    if (existsSync(join(profile, 'package.json'))) return resolve(profile);
  }
  return null;
}

/** patch 文件路径（profile 根下的 cordis.patch.yml）。 */
export function patchPath(profileDir) {
  return profileDir ? join(profileDir, 'cordis.patch.yml') : null;
}

function unquote(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function toScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (text === '') return "''";
  // 走单引号最省心：不用管 YAML 的保留字符，只要把内部的 ' 翻倍。
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 从 patch 文本里解析出本插件条目的 config。
 *
 * 只认最朴素的 key: value —— 我们的 patch 条目就是这么写的。解析不出来
 * 就返回空对象，宁可少读也不要把用户的 patch 改坏。
 */
export function parseEntryConfig(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^- id:\\s*${ENTRY_ID}\\s*$`).test(line.trim()));
  if (start < 0) return null;

  const config = {};
  let inConfig = false;
  let configIndent = -1;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^- id:/.test(line)) break; // 下一条目
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    if (!inConfig) {
      if (/^\s*config:\s*$/.test(line)) {
        inConfig = true;
        configIndent = indent;
      } else if (/^\s*config:\s*\{\s*\}\s*$/.test(line)) {
        return config; // config: {} —— 空配置
      }
      continue;
    }
    if (indent <= configIndent) break; // config 段结束

    const match = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue.trim() === '') continue; // 嵌套结构不处理
    if (/^\[.*\]$/.test(rawValue.trim())) {
      const inner = rawValue.trim().slice(1, -1).trim();
      config[key] = inner === ''
        ? []
        : inner.split(',').map((item) => unquote(item));
      continue;
    }
    const plain = unquote(rawValue);
    if (plain === 'true' || plain === 'false') config[key] = plain === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(plain)) config[key] = Number(plain);
    else config[key] = plain;
  }
  return config;
}

/** 把 config 渲染成 patch 里的 YAML 片段（缩进两格）。 */
export function renderEntry(config) {
  const keys = Object.keys(config).filter((key) => EDITABLE.includes(key));
  if (keys.length === 0) {
    return [`- id: ${ENTRY_ID}`, `  name: ${ENTRY_ID}`, '  config: {}'];
  }
  const lines = [`- id: ${ENTRY_ID}`, `  name: ${ENTRY_ID}`, '  config:'];
  for (const key of keys) {
    const value = config[key];
    if (Array.isArray(value)) {
      lines.push(`    ${key}: [${value.map((item) => toScalar(item)).join(', ')}]`);
    } else {
      lines.push(`    ${key}: ${toScalar(value)}`);
    }
  }
  return lines;
}

/**
 * 用新配置替换 patch 里的本插件条目。
 *
 * 条目不存在就追加到末尾。返回替换后的全文。
 */
export function replaceEntry(text, config) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  const block = renderEntry(config);
  const start = lines.findIndex((line) => new RegExp(`^- id:\\s*${ENTRY_ID}\\s*$`).test(line.trim()));

  if (start < 0) {
    const trimmed = source.replace(/\s+$/, '');
    const head = trimmed === '' ? [] : trimmed.split(/\r?\n/);
    return `${[...head, ...block].join('\n')}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !/^- id:/.test(lines[end])) end += 1;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  return [...before, ...block, ...after].join('\n');
}

/** 读 patch 里本插件当前的配置；没有条目返回 null。 */
export async function readStoredConfig(profileDir) {
  const path = patchPath(profileDir);
  if (!path || !existsSync(path)) return null;
  const text = await readFile(path, 'utf8');
  return parseEntryConfig(text);
}

/** 写回 patch；返回写入的配置。 */
export async function writeStoredConfig(profileDir, config) {
  const path = patchPath(profileDir);
  if (!path || !existsSync(path)) {
    throw new Error(
      `找不到 cordis.patch.yml（profile 目录=${profileDir ?? '未定位'}），无法持久化配置`,
    );
  }
  const text = await readFile(path, 'utf8');
  const next = replaceEntry(text, config);
  await writeFile(path, next, 'utf8');
  return { path, config };
}

/** 校验单个字段，返回 { ok, value } 或 { ok:false, error }。 */
export function coerceField(key, value) {
  const fail = (error) => ({ ok: false, error });
  if (!EDITABLE.includes(key)) {
    return fail(`未知配置项 "${key}"，可用：${EDITABLE.join(', ')}`);
  }
  const fallback = DEFAULTS[key];

  switch (key) {
    case 'theme':
      return THEMES.includes(value) ? { ok: true, value } : fail(`theme 只能是 ${THEMES.join(' / ')}`);
    case 'ratio':
      return RATIOS.includes(value) ? { ok: true, value } : fail(`ratio 只能是 ${RATIOS.join(' / ')}`);
    case 'autoFit':
      return AUTOFITS.includes(value) ? { ok: true, value } : fail(`autoFit 只能是 ${AUTOFITS.join(' / ')}`);
    case 'formats': {
      const list = Array.isArray(value) ? value : String(value).split(',').map((item) => item.trim());
      const bad = list.find((item) => !FORMATS.includes(item));
      if (bad) return fail(`formats 里有非法项 "${bad}"，可用：${FORMATS.join(' / ')}`);
      return list.length > 0 ? { ok: true, value: list } : fail('formats 不能为空');
    }
    case 'pageNumbers':
    case 'keepWarm': {
      if (typeof value === 'boolean') return { ok: true, value };
      const text = String(value).toLowerCase();
      if (['true', '1', 'on', 'yes', '开'].includes(text)) return { ok: true, value: true };
      if (['false', '0', 'off', 'no', '关'].includes(text)) return { ok: true, value: false };
      return fail(`${key} 只能是 true / false`);
    }
    case 'pngWidth':
    case 'minFontSize':
    case 'timeoutMs':
    case 'idleMs': {
      const number = Number(value);
      if (!Number.isFinite(number)) return fail(`${key} 必须是数字`);
      const ranges = {
        pngWidth: [320, 3840],
        minFontSize: [6, 72],
        timeoutMs: [5_000, 900_000],
        idleMs: [1_000, 1_800_000],
      };
      const [min, max] = ranges[key];
      const clamped = Math.min(max, Math.max(min, Math.round(number)));
      return { ok: true, value: clamped, clamped: clamped !== Math.round(number) };
    }
    default:
      // soffice / python / footer：字符串，允许空串
      if (value === null || value === undefined) return { ok: true, value: fallback };
      return { ok: true, value: String(value) };
  }
}

/** 当前生效的配置摘要（给 lo_config 的 show 用）。 */
export function describeConfig(current) {
  const rows = EDITABLE.map((key) => {
    const value = current[key];
    const shown = Array.isArray(value) ? value.join(', ') : value === '' ? '(空)' : String(value);
    return `  ${key.padEnd(12)} = ${shown}`;
  });
  return rows.join('\n');
}
