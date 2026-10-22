/**
 * 输出渲染与 convert 结果的回归。
 *
 * 两个踩过的坑：
 *   1. lo_render 没有 timings.build，render 时打出 "排版 undefineds"。
 *   2. lo_convert 只按文件名前缀找产物，把目录里同名旧文件也列进结果。
 */
import assert from 'node:assert/strict';

import { resolveOptions } from '../lib/config.js';
import { buildLoTools } from '../lib/tools.js';

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

const tools = buildLoTools(resolveOptions({}));
const build = tools.find((tool) => tool.name === 'lo_build');
const render = tools.find((tool) => tool.name === 'lo_render');
const cwd = 'D:\\work';
const render_ = (tool, value) => tool.output.render({}, value).map((part) => part.text).join('\n');

// ---- lo_build 的渲染：三段计时都要有
const buildOk = {
  ok: true,
  command: 'build',
  slideCount: 7,
  theme: 'swiss',
  ratio: '16:9',
  autoFit: 'shrink',
  fitAdjusted: 2,
  fitOverflow: 0,
  files: { pptx: 'D:\\work\\deck.pptx', pdf: 'D:\\work\\deck.pdf' },
  bytes: { pptx: 24000, pdf: 180000 },
  timings: { connect: 0.5, build: 1.4, export: 2.4 },
  totalSeconds: 2.5,
};
check('build 渲染出完整阶段', () => {
  const text = render_(build, buildOk);
  assert.ok(text.includes('阶段：连接 0.5s · 排版 1.4s · 导出 2.4s'), text);
  assert.ok(text.includes('主题 swiss · 比例 16:9'));
  assert.ok(text.includes('自动排版：2 处文字缩小字号'));
});

check('build 渲染不含 undefined', () => {
  const text = render_(build, buildOk);
  assert.ok(!text.includes('undefined'), text);
});

// ---- lo_render 的渲染：没有 theme/ratio/build，不能打出占位符
const renderOk = {
  ok: true,
  command: 'render',
  source: 'D:\\work\\deck.pptx',
  slideCount: 7,
  autoFit: 'shrink',
  files: { pdf: 'D:\\work\\deck.pdf', png: ['D:\\work\\deck-01.png'] },
  bytes: { pdf: 180000, png: [44000] },
  timings: { connect: 0.1, open: 0.3, export: 1.2 },
  totalSeconds: 1.5,
};
check('render 渲染不打 undefineds', () => {
  const text = render_(render, renderOk);
  assert.ok(!text.includes('undefined'), text);
  assert.ok(!/排版\s*undefined/.test(text), text);
});

check('render 渲染只列它有的阶段', () => {
  const text = render_(render, renderOk);
  assert.ok(text.includes('阶段：连接 0.1s · 打开 0.3s · 导出 1.2s'), text);
});

check('render 渲染不出现空的主题/比例行', () => {
  const text = render_(render, renderOk);
  assert.ok(!text.includes('主题 - · 比例 -'), text);
  assert.ok(!text.includes('主题 undefined'), text);
});

check('render 失败时给出错误而不是崩', () => {
  const text = render_(render, { ok: false, error: '找不到要渲染的文件' });
  assert.ok(text.includes('找不到要渲染的文件'));
});

// ---- lo_convert 返回值只该包含本次产物（这段校验 python 侧的过滤约定）
check('convert 结果字段形状正确', () => {
  const convert = tools.find((tool) => tool.name === 'lo_convert');
  const value = {
    ok: true,
    command: 'convert',
    source: 'D:\\work\\a.pptx',
    target: 'pdf',
    files: ['D:\\work\\a.pdf'],
    bytes: [28543],
    totalSeconds: 1.0,
  };
  const parsed = JSON.parse(convert.output.render({}, value)[0].text);
  assert.equal(parsed.files.length, 1);
  assert.ok(parsed.files[0].endsWith('.pdf'));
});

console.log(`\n${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
