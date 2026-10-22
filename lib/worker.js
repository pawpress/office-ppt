/**
 * dsh-lo-office —— 常驻桥进程。
 *
 * 每次调用都新起 python + soffice 的话，光 UNO 握手就要 ~0.5 秒（7 页 deck 总共
 * 2.4 秒，其中 20% 是启动开销）。这里维护一个「python --serve」进程，它内部复用
 * 同一个 soffice 和同一条 UNO 连接；实测第二次 build 只要 0.25 秒。
 *
 * 三条纪律：
 *   1. 一个 worker 同时只跑一个请求（UNO 不是线程安全的），排队串行化。
 *   2. 空闲到 idleMs 就回收，不长期占着一个 headless soffice。
 *   3. 取消/超时只能整只杀进程 —— UNO 调用没法中途打断，而 python 被杀时
 *      soffice 是它的子进程，Windows 上不会自动跟着退，所以用 taskkill /T 杀进程树。
 *
 * @module dsh-lo-office/worker
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 自己算桥脚本路径，不 import engine.js —— 否则两个模块循环依赖。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(HERE, '..', 'python', 'lo_bridge.py');

/** 没有响应时的兜底宽限：桥自己的超时应该先触发。 */
const RESPONSE_GRACE_MS = 5_000;

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    // soffice 是 python 的子进程；只杀 python 会留下一个 headless soffice。
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          /* 已经退出 */
        }
      });
      return;
    } catch {
      /* 落到下面 */
    }
  }
  try {
    child.kill();
  } catch {
    /* 已经退出 */
  }
}

class BridgeWorker {
  constructor({ python, soffice, idleMs }) {
    this.python = python;
    this.soffice = soffice;
    this.idleMs = idleMs;
    this.child = null;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = '';
    this.nextId = 1;
    this.chain = Promise.resolve();
    this.idleTimer = null;
    this.jobs = 0;
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  ensureChild() {
    if (this.running) return this.child;

    const child = spawn(this.python, ['-X', 'utf8', BRIDGE, '--serve'], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = '';
    this.stderrTail = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.on('error', (error) => this.#failAll(`常驻进程出错：${error.message}`));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.#failAll(`常驻进程退出（代码 ${code}）${this.stderrTail ? `\n${this.stderrTail.slice(-600)}` : ''}`);
    });
    return child;
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.#onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  #onLine(line) {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return; // 非 JSON 的杂音直接丢掉
    }
    const id = message?.id;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.settle(message);
  }

  #failAll(reason) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.settle({ ok: false, error: reason, workerDied: true });
    }
  }

  /** 排队跑一个请求。成功失败都以对象 resolve，不抛。 */
  request(payload, { timeoutMs, signal }) {
    const run = () => this.#run(payload, { timeoutMs, signal });
    const next = this.chain.then(run, run);
    // 链本身永不 reject，避免一次失败把后续请求全带下水
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #run(payload, { timeoutMs, signal }) {
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, aborted: true, error: '已取消' });
    }

    let child;
    try {
      child = this.ensureChild();
    } catch (error) {
      return Promise.resolve({
        ok: false,
        error: `无法启动常驻进程（${this.python}）：${error instanceof Error ? error.message : String(error)}`,
        hint: '把设置里的 python 指向 LibreOffice 自带的 python.exe',
      });
    }

    const id = this.nextId;
    this.nextId += 1;
    const started = Date.now();
    this.jobs += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    return new Promise((settle) => {
      const entry = {
        settle: (value) => {
          this.jobs -= 1;
          this.#scheduleIdle();
          settle({ ...value, elapsedMs: Date.now() - started });
        },
        timer: null,
      };
      this.pending.set(id, entry);

      const abort = () => {
        if (!this.pending.has(id)) return;
        // UNO 调用打断不了，只能连进程树一起杀，下一轮自动重启
        killTree(child);
        this.child = null;
        this.#failAll('已取消');
      };

      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', abort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', abort);
      }

      entry.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        killTree(child);
        this.child = null;
        this.jobs -= 1;
        this.#scheduleIdle();
        settle({
          ok: false,
          error: `常驻调用超时（${Math.round(timeoutMs / 1000)}s）：${payload.command}`,
          timedOut: true,
          elapsedMs: Date.now() - started,
        });
      }, timeoutMs + RESPONSE_GRACE_MS);

      try {
        const request = { ...payload, id };
        if (this.soffice) request.soffice = this.soffice;
        if (timeoutMs) request.timeout = Math.round(timeoutMs / 1000);
        child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8');
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        this.child = null;
        this.jobs -= 1;
        settle({
          ok: false,
          error: `写入常驻进程失败：${error instanceof Error ? error.message : String(error)}`,
          elapsedMs: Date.now() - started,
        });
      }
    });
  }

  #scheduleIdle() {
    if (this.jobs > 0 || this.idleTimer) return;
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.stop('空闲回收');
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** 优雅收工：先请它自己退（会带走 soffice），超时就杀进程树。 */
  async stop(reason = '关闭') {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed) return;

    const exited = new Promise((resolveExit) => {
      child.once('exit', () => resolveExit(true));
      setTimeout(() => resolveExit(false), 2_000).unref?.();
    });
    try {
      child.stdin.write(`${JSON.stringify({ command: 'shutdown', id: 0, reason })}\n`, 'utf8');
      child.stdin.end();
    } catch {
      /* 写不进去就直接杀 */
    }
    if (await exited) return;
    killTree(child);
  }
}

const workers = new Map();

function keyOf(python, soffice) {
  return `${python}|${soffice ?? ''}`;
}

/** 取（或新建）一个常驻 worker。 */
export function getWorker({ python, soffice, idleMs }) {
  const key = keyOf(python, soffice);
  let worker = workers.get(key);
  if (!worker) {
    worker = new BridgeWorker({ python, soffice, idleMs });
    workers.set(key, worker);
  } else {
    worker.idleMs = idleMs;
  }
  return worker;
}

/** 关掉所有常驻进程（插件卸载时调用）。 */
export async function stopAllWorkers(reason = '插件卸载') {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map((worker) => worker.stop(reason)));
}

/** 只看不改：给测试用。 */
export function workerStats() {
  return [...workers.values()].map((worker) => ({
    python: worker.python,
    running: worker.running,
    jobs: worker.jobs,
    pending: worker.pending.size,
  }));
}
