/**
 * 斜杠命令的回归：/ppt-config 与 /ppt-status 的解析与执行。
 *
 * 写盘走临时沙箱 profile，不碰真实配置。
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAssignments, registerCommands } from '../lib/commands.js';
import { resolveOptions } from '../lib/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

// ---------- 解析器（纯函数）
check('空输入 → 无参数', () => {
  assert.deepEqual(parseAssignments(''), { pairs: [], rest: '' });
  assert.deepEqual(parseAssignments('   '), { pairs: [], rest: '' });
});

check('reset → 重置标志', () => {
  assert.equal(parseAssignments('reset').reset, true);
  assert.equal(parseAssignments('--reset').reset, true);
});

check('单参数', () => {
  assert.deepEqual(parseAssignments('theme=swiss').pairs, [['theme', 'swiss']]);
});

check('多参数', () => {
  assert.deepEqual(parseAssignments('theme=swiss autoFit=off').pairs, [
    ['theme', 'swiss'],
    ['autoFit', 'off'],
  ]);
});

check('逗号值不被拆开（formats 靠这个）', () => {
  assert.deepEqual(parseAssignments('formats=pptx,pdf').pairs, [['formats', 'pptx,pdf']]);
});

check('引号包住带空格的值', () => {
  assert.deepEqual(parseAssignments('footer="hello world"').pairs, [['footer', 'hello world']]);
  assert.deepEqual(parseAssignments("footer='a b c'").pairs, [['footer', 'a b c']]);
});

check('多余文本进 rest', () => {
  assert.equal(parseAssignments('theme=swiss 乱写').rest, '乱写');
});

// ---------- 注册与执行
const sandbox = await mkdtemp(join(tmpdir(), 'lo-cmd-'));
const patchFile = join(sandbox, 'cordis.patch.yml');
await cp(join(HERE, '..', 'package.json'), join(sandbox, 'package.json'));
await cp(join(HERE, '..', 'cordis.patch.yml'), patchFile);
process.env.DSH_PROFILE_DIR = sandbox;

const registered = new Map();
const ctx = {
  logger: { warn: (message) => console.log(`  [warn] ${message}`) },
  commands: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`重复注册 ${definition.name}`);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
};

const disposers = registerCommands(ctx, resolveOptions({}));

check('注册了两个命令', () => {
  assert.deepEqual([...registered.keys()].sort(), ['ppt-config', 'ppt-status']);
});
check('命令都有描述和小写名', () => {
  for (const [name, definition] of registered) {
    assert.match(name, /^[a-z][a-z0-9_-]*$/);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 4);
    assert.equal(typeof definition.handler, 'function');
  }
});
check('ppt-config 声明了输入提示', () => {
  assert.ok(registered.get('ppt-config').input?.hint);
});

const show = await registered.get('ppt-config').handler({ rawInput: '' });
check('/ppt-config 查看配置', () => {
  assert.equal(show.kind, 'success');
  assert.ok(show.text.includes('theme'));
  assert.ok(show.text.includes('autoFit'));
  assert.ok(show.text.includes('(自动)'));
});

const set = await registered.get('ppt-config').handler({
  rawInput: 'theme=swiss autoFit=off pngWidth=2000',
});
check('/ppt-config 改三项', () => {
  assert.equal(set.kind, 'success');
  assert.ok(set.text.includes('theme=swiss'));
  assert.ok(set.text.includes('autoFit=off'));
});
const afterSet = await readFile(patchFile, 'utf8');
check('改动写进 cordis.patch.yml', () => {
  assert.ok(afterSet.includes('- id: dsh-lo-office'));
  assert.ok(afterSet.includes("theme: 'swiss'"));
  assert.ok(afterSet.includes("autoFit: 'off'"));
  assert.ok(afterSet.includes('pngWidth: 2000'));
});
check('只写非默认字段', () => {
  const lines = afterSet.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '- id: dsh-lo-office');
  const block = lines.slice(start, start + 8).join('\n');
  assert.ok(!block.includes('keepWarm'));
  assert.ok(!block.includes('timeoutMs'));
});

const badValue = await registered.get('ppt-config').handler({ rawInput: 'theme=neon' });
check('/ppt-config 拒绝非法值并给出用法', () => {
  assert.equal(badValue.kind, 'error');
  assert.match(badValue.text, /light/);
  assert.match(badValue.text, /用法/);
});
check('非法值不写盘', () => {
  assert.equal(badValue.kind, 'error');
});

const reset = await registered.get('ppt-config').handler({ rawInput: 'reset' });
check('/ppt-config reset 恢复出厂', () => {
  assert.equal(reset.kind, 'success');
  assert.ok(reset.text.includes('已恢复出厂'));
});
const afterReset = await readFile(patchFile, 'utf8');
check('reset 后 patch 条目清空但保留', () => {
  const lines = afterReset.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '- id: dsh-lo-office');
  assert.notEqual(start, -1);
  assert.equal(lines[start + 2].trim(), 'config: {}');
});

check('disposer 能注销命令', () => {
  assert.equal(disposers.length, 2);
  for (const dispose of disposers) dispose();
  assert.equal(registered.size, 0);
});

await rm(sandbox, { recursive: true, force: true });
delete process.env.DSH_PROFILE_DIR;

console.log(`\n${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
