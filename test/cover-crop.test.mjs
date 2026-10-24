// cover 裁切 + atelier 底色 回归测试
//
// 背景：0.1.1 里 add_image(cover=True) 用 createUnoStruct("com.sun.star.drawing.RectanglePoint")
// 去建裁切结构，而 RectanglePoint 是 ENUM —— createUnoStruct 必定抛异常，又被
// `except Exception: pass` 吞掉，于是满幅出血图静默退化成等比居中（上下留白）。
// 同一版本里 atelier 的 hero / image-left / image-right 分支没画主题底色，
// 带图的页直接变成纯白。两个 bug 都不会抛错，只能看像素。
//
// 所以这里跑一次真实的 lo_build，把 PNG 解出来按像素断言：
//   1. hero 满幅图的四角必须是图片内容（不是 atelier 米色 #F7F4EE）——留白就会露底色；
//   2. image-left 没被图覆盖的那半页必须是 atelier 米色（不是纯白 #FFFFFF）；
//   3. 构建结果里不许出现「cover 裁切失败」告警。

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveOptions } from '../lib/config.js';
import { buildLoTools } from '../lib/tools.js';

const ATELIER_BG = [0xF7, 0xF4, 0xEE]; // atelier 主题底色
const RED = [216, 41, 41];
const BLUE = [24, 48, 120];

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 8 位真彩（colorType 2）PNG，逐行 filter 0，够用且无外部依赖。 */
function encodePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o] = 0;
    o += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      o += 3;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- PNG 解码

/** 只支持 8 位真彩 / 真彩+alpha；LibreOffice 导出的截图就是这两类。 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`不支持的色彩类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const cur = Buffer.from(raw.subarray(src, src + stride));
    src += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`不支持的过滤器 ${filter}`);
      }
      cur[i] = v & 0xFF;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + x * channels;
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}

// ---------------------------------------------------------------- 调用口径

function run(tool, args, cwd) {
  const exec = { agent: { session: { header: { cwd } } }, signal: undefined };
  return tool.execute(args, exec);
}

const near = (a, b, tol = 12) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

const show = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export const NAME = 'cover 裁切与主题底色';

export async function runTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    try {
      fn();
      passed += 1;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${name} — ${error.message}`);
    }
  };

  const outDir = await mkdtemp(join(tmpdir(), 'lo-cover-'));
  const work = await mkdtemp(join(tmpdir(), 'lo-cover-src-'));
  const tools = buildLoTools(resolveOptions({}));
  const build = tools.find((tool) => tool.name === 'lo_build');

  try {
    // 1200x400 → 宽高比 3.0，塞进 16:9 满幅框时只会裁左右。
    // 上 55% 红、下 45% 蓝：裁切正确则页角是红，留白退化成等比居中则页角露底色。
    const imagePath = join(work, 'wide.png');
    await writeFile(imagePath, encodePng(1200, 400, (x, y) => (y < 220 ? RED : BLUE)));

    const value = await run(
      build,
      {
        title: 'cover 裁切回归',
        theme: 'atelier',
        formats: ['png'],
        pngWidth: 800,
        outputDir: outDir,
        fileName: 'cover-check',
        slides: [
          {
            layout: 'hero',
            kicker: 'REGRESSION',
            title: '满幅出血图不该留白',
            subtitle: '副标题也不能压到页脚',
            image: imagePath,
          },
          {
            layout: 'image-left',
            title: '半幅图版式',
            image: imagePath,
            bullets: ['没被图盖住的那半页', '应该是主题底色，不是纯白'],
          },
        ],
      },
      work,
    );

    const text = JSON.stringify(value);
    check('构建过程没有出现「cover 裁切失败」告警', () => {
      if (text.includes('裁切失败')) throw new Error('裁切仍然抛异常并退回等比缩放');
    });

    const pngs = (await readdir(outDir)).filter((name) => name.endsWith('.png')).sort();
    check('两页都导出了 PNG', () => {
      if (pngs.length < 2) throw new Error(`只拿到 ${pngs.length} 张：${pngs.join(', ') || '无'}`);
    });
    if (pngs.length < 2) {
      console.log(`\n${passed}/${passed + failed} 通过`);
      process.exitCode = 1;
      return;
    }

    const hero = decodePng(await readFile(join(outDir, pngs[0])));
    const half = decodePng(await readFile(join(outDir, pngs[1])));

    // 图是上红下蓝（55% / 45%），宽高比 3.0；hero 框是 16:9（1.778）。
    //
    // 退化行为（0.1.1 的 bug）：cover 建结构失败后退回等比居中，图只占页面中间
    // 约 59% 高，上下各露约 20% 白 —— 所以**页顶必须是红色**，白/底色都算失败。
    // 正确行为：满幅出血，页顶红、页脚被 hero 自带的暗色蒙版压住（不是白）。
    const isRed = (c) => c[0] > 120 && c[0] - c[2] > 60;
    const isDark = (c) => c[0] < 70 && c[1] < 70 && c[2] < 70;
    const isBlue = (c) => c[2] > 90 && c[2] - c[0] > 50;
    const blank = (c) =>
      near(c, [255, 255, 255], 8)
        ? `是纯白 ${show(c)} —— 图没铺到这里`
        : near(c, ATELIER_BG)
          ? `露底色 ${show(c)} —— 图被等比居中，没有裁切出血`
          : '';
    // 四角各自内缩 2.5%，避开圆角/抗锯齿边缘
    const ix = Math.max(6, Math.floor(hero.width * 0.025));
    const iy = Math.max(6, Math.floor(hero.height * 0.025));

    // 页顶两角：必须是图片上半部的红
    for (const [where, color] of [
      ['左上', hero.at(ix, iy)],
      ['右上', hero.at(hero.width - 1 - ix, iy)],
    ]) {
      check(`hero 满幅图${where}角取自图片红色区`, () => {
        const why = blank(color);
        if (why) throw new Error(why);
        if (!isRed(color)) throw new Error(`是 ${show(color)}，期望图片红色区 —— 图片纵向位置不对`);
      });
    }

    // 页脚两角：不许留白（蒙版压暗或仍是蓝色都算对）
    for (const [where, color] of [
      ['左下', hero.at(ix, hero.height - 1 - iy)],
      ['右下', hero.at(hero.width - 1 - ix, hero.height - 1 - iy)],
    ]) {
      check(`hero 满幅图${where}角没有留白`, () => {
        const why = blank(color);
        if (why) throw new Error(why);
        if (!isDark(color) && !isBlue(color)) {
          throw new Error(`是 ${show(color)}，既不是暗色蒙版也不是图片蓝色区 —— 疑似被压扁或拉伸`);
        }
      });
    }

    // 横向也要铺满：页面左右边缘的中上段必须是图片内容
    for (const [where, color] of [
      ['左边缘', hero.at(2, Math.floor(hero.height * 0.18))],
      ['右边缘', hero.at(hero.width - 3, Math.floor(hero.height * 0.18))],
    ]) {
      check(`hero 满幅图${where}铺到页边`, () => {
        const why = blank(color);
        if (why) throw new Error(why);
      });
    }

    // image-left：图占左半，右半页必须是主题底色
    const probes = [
      ['右上', half.at(half.width - 20, 10)],
      ['右中', half.at(half.width - 20, Math.floor(half.height / 2))],
    ];
    for (const [where, color] of probes) {
      check(`image-left ${where}是 atelier 底色`, () => {
        if (near(color, [255, 255, 255], 6)) throw new Error(`是纯白 ${show(color)} —— 主题底色没画`);
        if (!near(color, ATELIER_BG)) throw new Error(`是 ${show(color)}，期望 ${show(ATELIER_BG)}`);
      });
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} 通过`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.filename === process.argv[1]) await runTest();
