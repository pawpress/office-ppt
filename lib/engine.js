/**
 * dsh-lo-office —— Node 侧引擎层。
 *
 * 只做三件事：找 python、找 soffice、把一次 JSON 请求喂给 python/lo_bridge.py 并把
 * 它吐回来的 JSON 解析出来。所有 UNO 细节都在 Python 侧，Node 侧不碰。
 *
 * @module dsh-lo-office/engine
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BRIDGE = resolve(HERE, '..', 'python', 'lo_bridge.py');

/** 常见 LibreOffice 安装位置（Windows / macOS / Linux）。 */
const SOFFICE_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
];

export function findSoffice(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const key of ['DSH_LO_SOFFICE', 'LO_SOFFICE']) {
    const value = process.env[key];
    if (value && existsSync(value)) return value;
  }
  for (const candidate of SOFFICE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 找 python。优先级：
 *   1. 显式传入
 *   2. DSH_LO_PYTHON
 *   3. LibreOffice 自带 python（一定带 uno 模块）
 *   4. PATH 里的 python / python3（可能没装 uno）
 */
export function findPython(soffice, explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  const fromEnv = process.env.DSH_LO_PYTHON;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (soffice) {
    const bundled = join(dirname(soffice), process.platform === 'win32' ? 'python.exe' : 'python');
    if (existsSync(bundled)) return bundled;
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

/**
 * 跑一次桥调用。
 *
 * @param {object} request  { command, ... }
 * @param {object} options  { soffice, python, timeoutMs }
 * @returns {Promise<object>} 桥返回的 JSON（ok:false 也正常返回，不抛）
 */
export function runBridge(request, options = {}) {
  const soffice = findSoffice(options.soffice);
  const python = findPython(soffice, options.python);
  const timeoutMs = Number(options.timeoutMs ?? 180_000);
  const payload = { ...request };
  if (soffice) payload.soffice = soffice;

  return new Promise((resolvePromise) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    let child;
    try {
      child = spawn(python, ['-X', 'utf8', BRIDGE], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        ok: false,
        error: `无法启动 python（${python}）：${error instanceof Error ? error.message : String(error)}`,
        hint: '设置环境变量 DSH_LO_PYTHON 指向 LibreOffice 自带的 python.exe',
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
      finish({
        ok: false,
        error: `桥调用超时（${Math.round(timeoutMs / 1000)}s）：${request.command}`,
        timedOut: true,
        elapsedMs: Date.now() - started,
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: `python 进程出错：${error.message}`,
        python,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      const line = text.split(/\r?\n/).filter(Boolean).pop() ?? '';
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed) {
        finish({ ...parsed, elapsedMs: Date.now() - started });
        return;
      }
      finish({
        ok: false,
        error: `桥没有返回 JSON（退出码 ${code}）`,
        python,
        stdoutTail: text.slice(-1200),
        stderrTail: stderr.slice(-1200),
      });
    });

    try {
      child.stdin.write(JSON.stringify(payload), 'utf8');
      child.stdin.end();
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, error: `写入 stdin 失败：${error.message}` });
    }
  });
}

/** 探测本机 LibreOffice / python / UNO 是否可用。 */
export function probe(options = {}) {
  return runBridge({ command: 'probe', deep: options.deep !== false }, options);
}

/** 由 JSON 幻灯片规格生成 ODP / PPTX / PDF / 逐页 PNG。 */
export function buildDeck(spec, options = {}) {
  return runBridge(
    {
      command: 'build',
      spec,
      outDir: options.outDir,
      baseName: options.baseName,
      formats: options.formats ?? ['pptx'],
      pngWidth: options.pngWidth,
      timeout: Math.round(Number(options.timeoutMs ?? 180_000) / 1000),
    },
    options,
  );
}

/** 把已有的 PPT/PPTX/ODP 渲染成 PDF / 逐页 PNG。 */
export function renderDeck(source, options = {}) {
  return runBridge(
    {
      command: 'render',
      source,
      outDir: options.outDir,
      baseName: options.baseName,
      formats: options.formats ?? ['pdf'],
      pngWidth: options.pngWidth,
      timeout: Math.round(Number(options.timeoutMs ?? 180_000) / 1000),
    },
    options,
  );
}

/** 任意格式互转，走 soffice --convert-to。 */
export function convertFile(source, to, options = {}) {
  return runBridge(
    {
      command: 'convert',
      source,
      to,
      outDir: options.outDir,
      timeout: Math.round(Number(options.timeoutMs ?? 180_000) / 1000),
    },
    options,
  );
}
