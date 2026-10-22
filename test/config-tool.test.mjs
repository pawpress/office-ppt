/**
 * lo_config 的端到端回归：show / set / reset 的行为与返回值契约。
 *
 * 关键约束：工具返回值必须是「lossless JSON」——曾经因为 soffice/python 被归一化成
 * undefined，整份结果被 DSH 判废（value is not lossless JSON）。这里用真校验器守着。
 *
 * 写盘走临时沙箱 profile，不碰真实配置。
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOptions } from '../lib/config.js';
import { buildLoTools } from '../lib/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_APP_DIR ?? 'D:\\dsh\\DSH Desktop\\resources\\app';

let isJsonValue = null;
try {
  ({ isJsonValue } = await import(
    new URL(`file:///${APP.replace(/\\/g, '/')}/node_modules/@deepseek-ai/dsh-util-values/lib/index.js`).href
  ));
} catch {
  isJsonValue = null;
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 造一个沙箱 profile：只需要 package.json（用来定位）和 cordis.patch.yml（用来写）
const sandbox = await mkdtemp(join(tmpdir(), 'lo-cfg-'));
const patchFile = join(sandbox, 'cordis.patch.yml');
await cp(join(HERE, '..', 'cordis.patch.yml'), join(sandbox, 'bundle.patch.yml'));
await cp(join(HERE, '..', 'package.json'), join(sandbox, 'package.json'));
await cp(join(HERE, '..', 'cordis.patch.yml'), patchFile);
process.env.DSH_PROFILE_DIR = sandbox;

const tools = buildLoTools(resolveOptions({}));
const cfg = tools.find((tool) => tool.name === 'lo_config');
const render = (value) => cfg.output.render({}, value).map((part) => part.text).join('\n');
const exec = { agent: { session: { header: { cwd: process.cwd() } } } };

check('lo_config 已注册', () => assert.ok(cfg, 'lo_config 不在工具列表里'));

const shown = await cfg.execute({ action: 'show' }, exec);
check('show 成功', () => assert.equal(shown.ok, true));
check('show 返回值是 lossless JSON', () => {
  if (!isJsonValue) return; // 没有桌面端校验器时跳过
  assert.equal(isJsonValue(shown), true);
});
check('show 不含 undefined 字段', () => {
  const walk = (value, path = '') => {
    if (value === undefined) throw new Error(`${path} 是 undefined`);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    }
  };
  walk(shown, 'result');
});
check('show 覆盖全部 13 个字段', () => {
  assert.equal(Object.keys(shown.config).length, 13);
  for (const key of ['theme', 'ratio', 'formats', 'autoFit', 'minFontSize', 'keepWarm']) {
    assert.ok(key in shown.config, `缺少 ${key}`);
  }
});
check('show 的 soffice/python 是空串而不是 undefined', () => {
  assert.equal(shown.config.soffice, '');
  assert.equal(shown.config.python, '');
});
check('show 的文本里有字段值', () => {
  const text = render(shown);
  assert.ok(text.includes('theme'));
  assert.ok(text.includes('shrink'));
  assert.ok(text.includes('(自动)'), 'soffice/python 应显示为 (自动)');
});

const set = await cfg.execute(
  { action: 'set', changes: { theme: 'swiss', autoFit: 'off', pngWidth: 2000 } },
  exec,
);
check('set 成功并报告 3 项改动', () => {
  assert.equal(set.ok, true);
  assert.equal(set.changed.length, 3);
});
check('set 返回值是 lossless JSON', () => {
  if (!isJsonValue) return;
  assert.equal(isJsonValue(set), true);
});
check('set 当场改内存配置', () => {
  assert.equal(set.config.theme, 'swiss');
  assert.equal(set.config.autoFit, 'off');
  assert.equal(set.config.pngWidth, 2000);
});
const afterSet = await readFile(patchFile, 'utf8');
check('set 写进 cordis.patch.yml', () => {
  assert.ok(afterSet.includes('- id: dsh-lo-office'));
  assert.ok(afterSet.includes("theme: 'swiss'"));
  assert.ok(afterSet.includes("autoFit: 'off'"));
  assert.ok(afterSet.includes('pngWidth: 2000'));
});
check('set 只写非默认字段（theme/autoFit/pngWidth 三项，不含 keepWarm 等）', () => {
  const start = afterSet.split(/\r?\n/).findIndex((line) => line.trim() === '- id: dsh-lo-office');
  const block = afterSet.split(/\r?\n/).slice(start, start + 8).join('\n');
  assert.ok(!block.includes('keepWarm'), 'keepWarm 是默认值，不该写入');
  assert.ok(!block.includes('timeoutMs'));
});

const repeat = await cfg.execute({ action: 'set', key: 'theme', value: 'swiss' }, exec);
check('重复设同一个值不产生改动', () => {
  assert.equal(repeat.ok, true);
  assert.equal(repeat.changed.length, 0);
});

const bad = await cfg.execute({ action: 'set', key: 'theme', value: 'neon' }, exec);
check('非法枚举被拒且指出可选值', () => {
  assert.equal(bad.ok, false);
  assert.match(bad.error, /light/);
});
const badKey = await cfg.execute({ action: 'set', key: 'nope', value: 'x' }, exec);
check('未知字段被拒', () => assert.equal(badKey.ok, false));

const clamped = await cfg.execute({ action: 'set', key: 'pngWidth', value: 10 }, exec);
check('越界数字被夹住并标记', () => {
  assert.equal(clamped.ok, true);
  assert.equal(clamped.config.pngWidth, 320);
  assert.equal(clamped.changed[0].clamped, true);
});

const reset = await cfg.execute({ action: 'reset' }, exec);
check('reset 成功且回到出厂值', () => {
  assert.equal(reset.ok, true);
  assert.equal(reset.config.theme, 'light');
  assert.equal(reset.config.autoFit, 'shrink');
  assert.equal(reset.config.pngWidth, 1600);
});
check('reset 的文本列出改动字段（不是 [object Object]）', () => {
  const text = render(reset);
  assert.ok(!text.includes('[object Object]'), '渲染出了 [object Object]');
  assert.ok(text.includes('theme'));
});
const afterReset = await readFile(patchFile, 'utf8');
check('reset 后条目还在但配置清空', () => {
  const lines = afterReset.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '- id: dsh-lo-office');
  assert.notEqual(start, -1, '条目被删掉了');
  assert.equal(lines[start + 2].trim(), 'config: {}');
});

await rm(sandbox, { recursive: true, force: true });
delete process.env.DSH_PROFILE_DIR;

console.log(`\n${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
