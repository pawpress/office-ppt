/**
 * 自动排版的端到端回归：真起 LibreOffice，验证三种情况各自得到正确判定。
 *
 *   short  → 原字号放得下，不缩
 *   medium → 必须缩小字号
 *   huge   → 缩到下限仍放不下，计入 overflow
 *
 * 只跑真环境（需要 LibreOffice）。没有 soffice 时自动跳过，不算失败。
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDeck, findPython, findSoffice } from '../lib/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(HERE, '..', 'python', 'lo_bridge.py');
const LINE = 'this bullet line is deliberately long so the paragraph block grows past the box height';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const soffice = findSoffice();
if (!soffice) {
  console.log('SKIP 没找到 LibreOffice，跳过自动排版的端到端验证');
  process.exit(0);
}

const python = findPython(soffice);
const outDir = await mkdtemp(join(tmpdir(), 'lo-fit-'));
console.log(`soffice: ${soffice}\npython : ${python}\n`);

/** 直接跑 Python 桥，拿到自动排版的计数；不经过常驻 worker，避免影响别的测试。 */
function runBridgeSync(request) {
  const result = spawnSync(python, ['-X', 'utf8', BRIDGE], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: `桥没有返回 JSON（退出码 ${result.status}）${(result.stderr ?? '').slice(-400)}` };
  }
}

function build(bullets, baseName) {
  return runBridgeSync({
    command: 'build',
    outDir,
    baseName,
    formats: ['pptx'],
    autoFit: 'shrink',
    minFontSize: 12,
    timeout: 180,
    spec: {
      title: 'fit probe',
      theme: 'light',
      ratio: '16:9',
      slides: [{ layout: 'bullets', title: 'T', bullets }],
    },
  });
}

// ---- 关掉自动排版时不应有任何计数
const off = runBridgeSync({
  command: 'build',
  outDir,
  baseName: 'fit-off',
  formats: ['pptx'],
  autoFit: 'off',
  spec: {
    title: 'fit off',
    theme: 'light',
    ratio: '16:9',
    slides: [{ layout: 'bullets', title: 'T', bullets: Array.from({ length: 10 }, () => LINE) }],
  },
});
check('autoFit=off 时不缩字号', off.ok === true && off.autoFit === 'off', String(off.error ?? ''));
check('autoFit=off 时计数为 0', off.fitAdjusted === 0 && off.fitOverflow === 0, `${off.fitAdjusted}/${off.fitOverflow}`);

// ---- 少量文字：原字号就放得下
const short = build([LINE], 'fit-short');
check('短内容：生成成功', short.ok === true, String(short.error ?? ''));
check('短内容：不缩字号', short.fitAdjusted === 0 && short.fitOverflow === 0, `${short.fitAdjusted}/${short.fitOverflow}`);
if (short.files?.pptx) {
  const info = await stat(short.files.pptx);
  check('短内容：pptx 落盘', info.size > 5000, `${info.size} 字节`);
}

// ---- 中等文字：必须缩小字号
const medium = build(Array.from({ length: 8 }, () => LINE), 'fit-medium');
check('中等内容：生成成功', medium.ok === true, String(medium.error ?? ''));
check('中等内容：确实缩小了字号', medium.fitAdjusted === 1, `fitAdjusted=${medium.fitAdjusted}`);
check('中等内容：没有误报溢出', medium.fitOverflow === 0, `fitOverflow=${medium.fitOverflow}`);

// ---- 超量文字：缩到下限仍放不下
const huge = build(Array.from({ length: 10 }, () => LINE), 'fit-huge');
check('超量内容：生成成功（不中断）', huge.ok === true, String(huge.error ?? ''));
check('超量内容：被记为溢出', huge.fitOverflow === 1, `fitOverflow=${huge.fitOverflow}`);

// ---- 常规引擎路径（走常驻 worker）仍能出图
const viaEngine = await buildDeck(
  {
    title: 'engine path',
    theme: 'light',
    ratio: '16:9',
    slides: [{ layout: 'cover', title: 'via engine' }],
  },
  { outDir, baseName: 'fit-engine', formats: ['pptx'], autoFit: 'shrink', timeoutMs: 240_000 },
);
check('引擎路径（常驻 worker）可用', viaEngine.ok === true, String(viaEngine.error ?? ''));
check('引擎路径返回 autoFit 字段', viaEngine.autoFit === 'shrink', String(viaEngine.autoFit));

await rm(outDir, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
