#!/usr/bin/env node
/**
 * dsh-lo-office 命令行入口 —— 不走 DSH 也能直接用。
 *
 *   node bin/lo-ppt.mjs probe
 *   node bin/lo-ppt.mjs build deck.json --out ./out --formats pptx,pdf,png
 *   node bin/lo-ppt.mjs render deck.pptx --formats png --png-width 1600
 *   node bin/lo-ppt.mjs convert deck.odp --to pdf
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildDeck, convertFile, probe, renderDeck } from '../lib/engine.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(item);
    }
  }
  return { positional, flags };
}

function splitList(value, fallback) {
  if (!value || value === true) return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, target] = positional;

let result;
try {
  if (command === 'probe' || !command) {
    result = await probe({ deep: flags.deep !== 'false' });
  } else if (command === 'build') {
    if (!target) throw new Error('用法：build <spec.json> [--out dir]');
    const spec = JSON.parse(await readFile(resolve(target), 'utf8'));
    const inner = spec.spec ?? spec;
    result = await buildDeck(inner, {
      outDir: flags.out ? resolve(flags.out) : resolve('.'),
      baseName: flags.name ? String(flags.name) : undefined,
      formats: splitList(flags.formats, ['pptx', 'pdf', 'png']),
      pngWidth: flags['png-width'] ? Number(flags['png-width']) : 1600,
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
    });
  } else if (command === 'render') {
    if (!target) throw new Error('用法：render <pptx> [--formats pdf,png]');
    result = await renderDeck(resolve(target), {
      outDir: flags.out ? resolve(flags.out) : undefined,
      formats: splitList(flags.formats, ['pdf', 'png']),
      pngWidth: flags['png-width'] ? Number(flags['png-width']) : 1600,
    });
  } else if (command === 'convert') {
    if (!target || !flags.to) throw new Error('用法：convert <file> --to pdf');
    result = await convertFile(resolve(target), String(flags.to), {
      outDir: flags.out ? resolve(flags.out) : undefined,
    });
  } else {
    throw new Error(`未知命令：${command}（可用：probe / build / render / convert）`);
  }
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error) };
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result?.ok ? 0 : 1;
