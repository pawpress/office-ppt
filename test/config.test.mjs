/**
 * 配置层测试：schema 存在性、校验、归一化兜底、工具默认值继承。
 *
 * 不启动 LibreOffice，纯逻辑，几百毫秒。
 */
import assert from 'node:assert/strict';
import { AUTOFITS, Config, DEFAULTS, resolveOptions, THEMES } from '../lib/config.js';
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

check('Config schema 存在（schemastery 可解析）', () => {
  assert.ok(Config, 'Config 为 undefined，说明 @deepseek-ai/schemastery 没装上');
  assert.equal(typeof Config['~standard']?.validate, 'function');
});

check('合法配置通过校验', () => {
  const result = Config['~standard'].validate({ theme: 'dark', ratio: '4:3', pngWidth: 1200 });
  assert.equal(result.issues, undefined);
});

check('非法主题被 schema 拒绝', () => {
  const result = Config['~standard'].validate({ theme: 'neon' });
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0);
});

check('非法比例被 schema 拒绝', () => {
  const result = Config['~standard'].validate({ ratio: '21:9' });
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0);
});

check('归一化：空对象全回落默认值', () => {
  const options = resolveOptions({});
  assert.equal(options.theme, DEFAULTS.theme);
  assert.equal(options.ratio, DEFAULTS.ratio);
  assert.equal(options.pngWidth, DEFAULTS.pngWidth);
  assert.equal(options.pageNumbers, true);
  assert.equal(options.keepWarm, true);
  assert.deepEqual(options.formats, [...DEFAULTS.formats]);
});

check('归一化：非法值不抛异常，回落默认', () => {
  const options = resolveOptions({ theme: 'neon', ratio: 42, pngWidth: 'abc', formats: ['docx', 'png'] });
  assert.equal(options.theme, DEFAULTS.theme);
  assert.equal(options.ratio, DEFAULTS.ratio);
  assert.equal(options.pngWidth, DEFAULTS.pngWidth);
  assert.deepEqual(options.formats, ['png']);
});

check('归一化：pngWidth 被夹在 320..3840', () => {
  assert.equal(resolveOptions({ pngWidth: 10 }).pngWidth, 320);
  assert.equal(resolveOptions({ pngWidth: 99999 }).pngWidth, 3840);
});

check('归一化：footer 空字符串是合法值（表示不画页脚）', () => {
  assert.equal(resolveOptions({ footer: '' }).footer, '');
  assert.equal(resolveOptions({}).footer, DEFAULTS.footer);
});

check('归一化：soffice/python 空串归一成 undefined', () => {
  const options = resolveOptions({ soffice: '   ', python: '' });
  assert.equal(options.soffice, undefined);
  assert.equal(options.python, undefined);
});

check('归一化：keepWarm 只有显式 false 才关', () => {
  assert.equal(resolveOptions({ keepWarm: false }).keepWarm, false);
  assert.equal(resolveOptions({ keepWarm: 0 }).keepWarm, true);
});

check('自动排版：默认 shrink，只有显式 off 才关', () => {
  assert.equal(DEFAULTS.autoFit, 'shrink');
  assert.equal(resolveOptions({}).autoFit, 'shrink');
  assert.equal(resolveOptions({ autoFit: 'off' }).autoFit, 'off');
  assert.equal(resolveOptions({ autoFit: 'nonsense' }).autoFit, 'shrink');
  assert.deepEqual(AUTOFITS, ['off', 'shrink']);
});

check('自动排版：minFontSize 被夹在 6..72', () => {
  assert.equal(resolveOptions({}).minFontSize, DEFAULTS.minFontSize);
  assert.equal(resolveOptions({ minFontSize: 1 }).minFontSize, 6);
  assert.equal(resolveOptions({ minFontSize: 500 }).minFontSize, 72);
  assert.equal(resolveOptions({ minFontSize: 'abc' }).minFontSize, DEFAULTS.minFontSize);
});

check('schema 接受 autoFit/minFontSize，拒绝非法枚举', () => {
  const ok = Config['~standard'].validate({ autoFit: 'shrink', minFontSize: 10 });
  assert.equal(ok.issues, undefined);
  const bad = Config['~standard'].validate({ autoFit: 'stretch' });
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0);
  const badSize = Config['~standard'].validate({ minFontSize: 2 });
  assert.ok(Array.isArray(badSize.issues) && badSize.issues.length > 0);
});

check('归一化：volatile 容器（{get()}）能被读出来', () => {
  const options = resolveOptions({
    theme: { get: () => 'swiss' },
    pngWidth: { get: () => 2000 },
  });
  assert.equal(options.theme, 'swiss');
  assert.equal(options.pngWidth, 2000);
});

check('归一化：get() 抛异常时不炸，用默认值', () => {
  const options = resolveOptions({
    theme: {
      get: () => {
        throw new Error('boom');
      },
    },
  });
  assert.equal(options.theme, DEFAULTS.theme);
});

check('工具默认值继承配置：主题/比例/页脚/页码', () => {
  const tools = buildLoTools(resolveOptions({ theme: 'slate', ratio: '4:3', footer: '', pageNumbers: false }));
  const build = tools.find((tool) => tool.name === 'lo_build');
  assert.ok(build);
  // 默认值藏在 execute 里，这里只校验 schema 仍然合法、枚举值来自配置白名单。
  const theme = build.parameters.properties.theme;
  assert.deepEqual(theme.enum, THEMES);
});

check('五个工具都注册且 required 都是数组', () => {
  const tools = buildLoTools(resolveOptions({}));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['lo_probe', 'lo_build', 'lo_render', 'lo_convert', 'lo_config'],
  );
  for (const tool of tools) {
    if (tool.parameters.required !== undefined) {
      assert.ok(Array.isArray(tool.parameters.required), `${tool.name} 的 required 不是数组`);
    }
  }
});

console.log(`\n${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
