/**
 * 回归检查：工具返回值必须通过 DSH 的 lossless-JSON 校验。
 *
 * 背景：曾经用 `Object.defineProperty(result, '__cwd', { enumerable: false })`
 * 把会话 cwd 挂在返回值上，DSH 的 enumerableStringKeys() 见到非枚举自有键就整值判废，
 * 报 "tool returned invalid output: value is not lossless JSON"。现在改用 WeakMap。
 *
 * 这个脚本直接调用 app 自带的 isJsonValue 校验器，不需要重启桌面端就能验证。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = process.env.DSH_APP_DIR ?? 'D:\\dsh\\DSH Desktop\\resources\\app';
const VALIDATOR = join(APP, 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js');

/**
 * 本地镜像：DSH 校验器不在时（CI / 没装桌面端）按同一套规则判定。
 * 规则照 `dsh-util-values` 的 walkJsonValue 抄：非枚举自有键、非字符串键、
 * 非有限数字、-0、稀疏数组、非 plain 原型，全部判废。
 */
function localIsJsonValue(value) {
  const seen = new Set();
  const walk = (current) => {
    if (current === null) return true;
    const type = typeof current;
    if (type === 'boolean' || type === 'string') return true;
    if (type === 'number') return Number.isFinite(current) && !Object.is(current, -0);
    if (type !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    let ok = true;
    if (Array.isArray(current)) {
      // 稀疏数组会被 JSON 往返吞掉空洞。
      ok = Reflect.ownKeys(current).length === current.length + 1;
      for (let index = 0; ok && index < current.length; index += 1) {
        ok = Object.prototype.hasOwnProperty.call(current, index) && walk(current[index]);
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      const plain = prototype === null || Object.getPrototypeOf(prototype) === null;
      ok = plain && Reflect.ownKeys(current).every((key) => {
        return typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(current, key) && walk(current[key]);
      });
    }
    seen.delete(current);
    return ok;
  };
  return walk(value);
}

let isJsonValue = localIsJsonValue;
let validatorSource = '本地镜像（没找到 DSH 自带校验器）';
if (existsSync(VALIDATOR)) {
  ({ isJsonValue } = await import(pathToFileURL(VALIDATOR).href));
  validatorSource = VALIDATOR;
}
console.log(`校验器：${validatorSource}\n`);

const { buildLoTools } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'tools.js')).href);

const tools = buildLoTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const exec = { agent: { session: { header: { cwd: process.cwd() } } }, signal: undefined };

const outDir = await mkdtemp(join(tmpdir(), 'lo-json-'));
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

for (const name of ['lo_probe', 'lo_build', 'lo_render', 'lo_convert']) {
  const tool = byName.get(name);
  check(`${name} 已注册`, Boolean(tool));
  check(`${name} parameters 是合法 JSON Schema 对象`, isJsonValue(tool.parameters));
  check(`${name} output.schema 是合法 JSON`, isJsonValue(tool.output.schema));
}

const build = byName.get('lo_build');
const built = await build.execute(
  {
    title: 'lossless JSON 回归',
    slides: [
      { layout: 'cover', title: '返回值必须是纯 JSON', subtitle: '非枚举属性会被 DSH 判废' },
      { layout: 'bullets', title: '检查点', bullets: ['弱引用存 cwd', '返回值零附加属性', 'render 仍能显示相对路径'] },
    ],
    formats: ['pptx', 'png'],
    outputDir: outDir,
    fileName: 'json-check',
    pngWidth: 800,
  },
  exec,
);
check('lo_build 返回值通过 lossless JSON 校验', isJsonValue(built), built.ok ? '' : String(built.error));
check('返回值没有额外自有键', Reflect.ownKeys(built).every((key) => typeof key === 'string'));
const text = build.output.render({}, built).map((part) => part.text).join('\n');
check('render 能出文本', text.includes('生成完成'));
check('render 用相对路径（cwd 经 WeakMap 取到）', !text.includes(outDir), text.split('\n').slice(0, 3).join(' | '));

const probe = byName.get('lo_probe');
const probed = await probe.execute({}, exec);
check('lo_probe 返回值通过 lossless JSON 校验', isJsonValue(probed));

await rm(outDir, { recursive: true, force: true });
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
