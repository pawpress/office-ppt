/**
 * 冒烟测试：不启动 DSH，直接按 DSH 的调用形状跑一遍插件。
 *
 *   node test/smoke.mjs
 *
 * 覆盖：apply() 注册、四个工具的定义合法性、lo_probe / lo_build / lo_render 的真实执行、
 * output.render 的文本输出。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, name } from '../lib/index.js';

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail });
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** 收集注册的工具，模拟 DSH 的 ctx。 */
function fakeContext() {
  const tools = new Map();
  const disposers = [];
  return {
    tools,
    ctx: {
      logger: { warn: (message) => console.log(`[warn] ${message}`) },
      tools: {
        register(definition) {
          tools.set(definition.name, definition);
          const dispose = () => tools.delete(definition.name);
          disposers.push(dispose);
          return dispose;
        },
      },
      on(event, handler) {
        if (event === 'dispose') disposers.push(handler);
      },
    },
  };
}

const { ctx, tools } = fakeContext();
apply(ctx, {});

// inject 支持两种形态：数组，或 { required, optional }。后者用来让 commands 成为可选依赖。
const injectRequired = Array.isArray(inject) ? inject : (inject?.required ?? []);
const injectOptional = Array.isArray(inject) ? [] : (inject?.optional ?? []);
check('inject 声明了 tools', injectRequired.includes('tools'), JSON.stringify(inject));
check('inject 把 commands 列为可选', injectOptional.includes('commands'), JSON.stringify(inject));
check('插件名正确', name === 'dsh-lo-office', name);
check('注册了 5 个工具', tools.size === 5, [...tools.keys()].join(', '));

for (const [toolName, definition] of tools) {
  const schemaOk = definition.parameters && definition.parameters.type === 'object';
  const hasRender = typeof definition.output?.render === 'function';
  const hasExecute = typeof definition.execute === 'function';
  check(
    `${toolName} 定义合法`,
    schemaOk && hasRender && hasExecute && typeof definition.description === 'string' && definition.description.length > 40,
    `parameters=${schemaOk} render=${hasRender} execute=${hasExecute}`,
  );
}

const exec = { agent: { session: { header: { cwd: process.cwd() } } }, signal: undefined };

// ---- lo_probe
const probeValue = await tools.get('lo_probe').execute({}, exec);
check('lo_probe ok', probeValue.ok === true, probeValue.soffice ?? probeValue.error ?? '');
check('lo_probe 拿到版本号', typeof probeValue.version === 'string' && /LibreOffice/i.test(probeValue.version), probeValue.version ?? '');
check('lo_probe UNO 可用', probeValue.uno === true, String(probeValue.uno));
check('lo_probe 能真开文档', probeValue.live === true, probeValue.liveError ?? `${probeValue.livePages} 页`);
const probeText = tools.get('lo_probe').output.render({}, probeValue);
check('lo_probe render 出文本', probeText?.[0]?.type === 'text' && probeText[0].text.includes('LibreOffice'), probeText?.[0]?.text?.split('\n')[0] ?? '');

// ---- lo_build（真建 deck）
const outDir = await mkdtemp(join(tmpdir(), 'lo-smoke-'));
const buildArgs = {
  title: '冒烟测试',
  theme: 'light',
  ratio: '16:9',
  formats: ['pptx', 'pdf', 'png'],
  pngWidth: 1200,
  outputDir: outDir,
  fileName: 'smoke',
  slides: [
    { layout: 'cover', title: '冒烟测试', subtitle: '由本机 LibreOffice 生成' },
    { layout: 'bullets', kicker: '验证', title: '四个工具', bullets: ['lo_probe', 'lo_build', 'lo_render', 'lo_convert'] },
    {
      layout: 'table',
      title: '表格',
      rows: [
        ['工具', '作用'],
        ['lo_build', '建 deck'],
        ['lo_render', '渲染'],
      ],
    },
    { layout: 'statement', text: '真 Impress，不是纯 JS 拼 XML。' },
    { layout: 'quote', text: '转换不发现系统 LibreOffice。', subtitle: '@deepseek-ai/libreoffice-kit README' },
    { layout: 'closing', title: '完', subtitle: 'dsh-lo-office' },
  ],
};

const buildValue = await tools.get('lo_build').execute(buildArgs, exec);
check('lo_build ok', buildValue.ok === true, buildValue.error ?? '');
check('lo_build 页数正确', buildValue.slideCount === 6, String(buildValue.slideCount));
check('lo_build 出了 pptx', typeof buildValue.files?.pptx === 'string', buildValue.files?.pptx ?? '');
check('lo_build 出了 pdf', typeof buildValue.files?.pdf === 'string', buildValue.files?.pdf ?? '');
check('lo_build 出了 6 张 png', Array.isArray(buildValue.files?.png) && buildValue.files.png.length === 6, String(buildValue.files?.png?.length));

if (buildValue.files?.pptx) {
  const info = await stat(buildValue.files.pptx);
  check('pptx 文件非空', info.size > 8000, `${info.size} 字节`);
  const buffer = await readFile(buildValue.files.pptx);
  check('pptx 是 zip 容器', buffer[0] === 0x50 && buffer[1] === 0x4b, buffer.subarray(0, 2).toString('hex'));
}

if (Array.isArray(buildValue.files?.png) && buildValue.files.png.length > 0) {
  const sizes = await Promise.all(buildValue.files.png.map(async (file) => (await stat(file)).size));
  check('每张 png 都非空', sizes.every((size) => size > 3000), sizes.join(','));
  check('png 内容各不相同', new Set(sizes).size > 1, `distinct=${new Set(sizes).size}`);
}

const buildText = tools.get('lo_build').output.render({ ...buildArgs, __cwd: process.cwd() }, buildValue);
check('lo_build render 出文本', buildText?.[0]?.type === 'text' && buildText[0].text.includes('生成完成'), buildText?.[0]?.text?.split('\n')[0] ?? '');

// ---- lo_render（把刚生成的 pptx 再渲一遍）
if (buildValue.files?.pptx) {
  const renderValue = await tools.get('lo_render').execute(
    { source: buildValue.files.pptx, formats: ['pdf', 'png'], outputDir: join(outDir, 'rendered'), pngWidth: 1200 },
    exec,
  );
  check('lo_render ok', renderValue.ok === true, renderValue.error ?? '');
  check('lo_render 出了 png', Array.isArray(renderValue.files?.png) && renderValue.files.png.length === 6, String(renderValue.files?.png?.length));
}

// ---- 缺参数时给出可读错误
const badRender = await tools.get('lo_render').execute({}, exec);
check('缺 source 时报错而不是崩', badRender.ok === false && typeof badRender.error === 'string', badRender.error ?? '');

const missing = await tools.get('lo_render').execute({ source: join(outDir, '不存在.pptx') }, exec);
check('文件不存在时报错', missing.ok === false, String(missing.error ?? '').slice(0, 80));

await rm(outDir, { recursive: true, force: true });

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const item of failed) console.log(` - ${item.label} ${item.detail}`);
  process.exitCode = 1;
}
