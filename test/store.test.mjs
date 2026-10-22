/**
 * lo_config 的纯逻辑测试：YAML 条目的解析 / 渲染 / 替换，以及字段校验。
 *
 * 全部在内存里做，不碰真实 profile。
 */
import assert from 'node:assert/strict';

import {
  EDITABLE,
  coerceField,
  parseEntryConfig,
  renderEntry,
  replaceEntry,
} from '../lib/store.js';

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

const SAMPLE = `# 用户自己的覆盖层
- id: desktop-shell
  name: dsh-plugin-desktop
  config:
    mode: extended
- id: dsh-lo-office
  name: dsh-lo-office
  config: {}
- id: dsh-ppt
  name: dsh-ppt
  config: {}
`;

check('解析 config: {} 空配置', () => {
  const config = parseEntryConfig(SAMPLE);
  assert.deepEqual(config, {});
});

check('解析非空 config 的标量/布尔/数组', () => {
  const text = `- id: dsh-lo-office
  name: dsh-lo-office
  config:
    theme: swiss
    autoFit: 'off'
    pngWidth: 2400
    pageNumbers: false
    formats: [pptx, pdf]
    footer: 'it''s ok'
- id: next
  name: next
`;
  const config = parseEntryConfig(text);
  assert.equal(config.theme, 'swiss');
  assert.equal(config.autoFit, 'off');
  assert.equal(config.pngWidth, 2400);
  assert.equal(config.pageNumbers, false);
  assert.deepEqual(config.formats, ['pptx', 'pdf']);
  assert.equal(config.footer, "it's ok");
});

check('条目不存在时解析返回 null', () => {
  assert.equal(parseEntryConfig('- id: other\n  name: other\n'), null);
});

check('渲染：空配置输出 config: {}', () => {
  const lines = renderEntry({});
  assert.deepEqual(lines, ['- id: dsh-lo-office', '  name: dsh-lo-office', '  config: {}']);
});

check('渲染：非空配置按两格缩进', () => {
  const lines = renderEntry({ theme: 'dark', pngWidth: 1200, formats: ['pptx', 'pdf'] });
  assert.ok(lines.includes('    theme: \'dark\''));
  assert.ok(lines.includes('    pngWidth: 1200'));
  assert.ok(lines.includes('    formats: [\'pptx\', \'pdf\']'));
});

check('替换：只替本插件条目，邻居不受影响', () => {
  const next = replaceEntry(SAMPLE, { theme: 'warm' });
  const lines = next.split(/\r?\n/);
  assert.ok(next.includes('- id: desktop-shell'));
  assert.ok(next.includes('- id: dsh-ppt'));
  assert.ok(next.includes("    theme: 'warm'"));
  // 邻条目各出现一次
  assert.equal(lines.filter((line) => line.trim() === '- id: dsh-ppt').length, 1);
  assert.equal(lines.filter((line) => line.trim() === '- id: dsh-lo-office').length, 1);
  // dsh-ppt 自己的 config: {} 必须原样保留（那是别人的条目）
  assert.equal(
    lines.filter((line) => line.trim() === 'config: {}').length,
    1,
    'dsh-ppt 的 config: {} 不该被抹掉',
  );
  // 本插件条目里不能再有旧的空 config
  const start = lines.findIndex((line) => line.trim() === '- id: dsh-lo-office');
  assert.notEqual(lines[start + 2].trim(), 'config: {}');
});

check('替换：条目不存在时追加到末尾', () => {
  const text = '- id: only\n  name: only\n';
  const next = replaceEntry(text, { theme: 'dark' });
  assert.ok(next.includes('- id: only'));
  assert.ok(next.includes("- id: dsh-lo-office"));
  assert.ok(next.includes("    theme: 'dark'"));
});

check('往返：渲染后再解析得到同一份配置', () => {
  const config = { theme: 'slate', ratio: '4:3', autoFit: 'off', pngWidth: 2000, pageNumbers: false };
  const text = replaceEntry(SAMPLE, config);
  const back = parseEntryConfig(text);
  assert.equal(back.theme, 'slate');
  assert.equal(back.ratio, '4:3');
  assert.equal(back.autoFit, 'off');
  assert.equal(back.pngWidth, 2000);
  assert.equal(back.pageNumbers, false);
});

check('校验：合法枚举通过', () => {
  assert.equal(coerceField('theme', 'swiss').value, 'swiss');
  assert.equal(coerceField('autoFit', 'off').value, 'off');
  assert.deepEqual(coerceField('formats', 'pptx,pdf').value, ['pptx', 'pdf']);
});

check('校验：非法枚举被拒', () => {
  assert.equal(coerceField('theme', 'neon').ok, false);
  assert.equal(coerceField('autoFit', 'stretch').ok, false);
  assert.equal(coerceField('formats', 'docx').ok, false);
  assert.equal(coerceField('nope', 'x').ok, false);
});

check('校验：数字被夹到范围内并标记 clamped', () => {
  const low = coerceField('pngWidth', 10);
  assert.equal(low.value, 320);
  assert.equal(low.clamped, true);
  const high = coerceField('minFontSize', 500);
  assert.equal(high.value, 72);
  assert.equal(high.clamped, true);
});

check('校验：布尔接受多种写法', () => {
  assert.equal(coerceField('keepWarm', 'false').value, false);
  assert.equal(coerceField('keepWarm', '关').value, false);
  assert.equal(coerceField('pageNumbers', 'on').value, true);
  assert.equal(coerceField('pageNumbers', true).value, true);
});

check('EDITABLE 覆盖全部 schema 字段', () => {
  assert.deepEqual(EDITABLE, [
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
  ]);
});

check('替换：本插件不在 patch 里时是新增，不破坏已有条目', () => {
  // 真实 profile 的 patch 就是这种情况：dsh-lo-office 只在生成物 cordis.yml 里。
  const text = `- id: desktop-shell
  name: dsh-plugin-desktop
  config:
    mode: extended
- id: dsh-infinite-gen-5
  disabled: false
`;
  const next = replaceEntry(text, { theme: 'swiss', autoFit: 'off' });
  const lines = next.split(/\r?\n/);
  assert.equal(lines.filter((line) => /^- id:/.test(line)).length, 3);
  assert.ok(next.startsWith('- id: desktop-shell'));
  assert.ok(next.includes('- id: dsh-infinite-gen-5'));
  const back = parseEntryConfig(next);
  assert.deepEqual(back, { theme: 'swiss', autoFit: 'off' });
});

console.log(`\n${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
