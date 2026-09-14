/**
 * normalize-assets — the asset pipeline (PROJECT.md, Extra).
 *
 * Drop any icon/logo files (any size, any of png/jpg/webp/bmp) into
 * assets/raw/ and run `npm run assets`. Each file is matched to a slot by
 * name, letterboxed to the slot's canonical square size, re-encoded as PNG
 * with metadata stripped, and budget-checked so embedded files stay small
 * (progressive downscale until under budget). The Windows .ico is rebuilt
 * from the icon. Missing slots get a quiet placeholder so the app always
 * builds. assets/manifest.json records every generated file.
 */
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Jimp } from 'jimp';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const RAW = path.join(ROOT, 'assets', 'raw');
const KB = 1024;

// name pattern is matched against the raw filename; budget in bytes
const SLOTS = [
  { file: 'assets/icon.png', size: 512, budget: 96 * KB, match: /icon/i, avoid: [/tray/i, /logo/i] },
  { file: 'assets/tray.png', size: 32, budget: 8 * KB, match: /tray|menu/i },
  { file: 'assets/logo.png', size: 512, budget: 64 * KB, match: /logo|mark|word/i },
  { file: 'assets/logo@2x.png', size: 1024, budget: 128 * KB, match: /logo|mark|word/i, preferLarge: true },
  { file: 'assets/icon.ico', derived: 'icon' },
];

const READABLE = /\.(png|jpe?g|webp|bmp)$/i;

/** Letterbox onto a square transparent canvas of `size`, then encode PNG. */
async function renderSquare(source, size) {
  const canvas = new Jimp({ width: size, height: size, color: 0x00000000 });
  const scale = Math.min(size / source.width, size / source.height);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const resized = source.clone().resize({ w, h });
  canvas.composite(resized, Math.round((size - w) / 2), Math.round((size - h) / 2));
  return canvas;
}

/** Encode under budget by stepping the canvas down until it fits. */
async function encodeBudgeted(source, size, budget, file) {
  let s = size;
  for (;;) {
    const canvas = await renderSquare(source, s);
    const buf = await canvas.getBuffer('image/png');
    if (buf.length <= budget || s <= 128) {
      if (buf.length > budget) console.warn(`  ! ${file} is ${buf.length} bytes (> ${budget}) — kept at ${s}px floor`);
      return buf;
    }
    s = Math.round(s * 0.85);
  }
}

/** Minimal geometric placeholder so every slot exists before real art lands. */
async function placeholder(size, kind) {
  const img = new Jimp({ width: size, height: size, color: 0x00000000 });
  const c = size / 2;
  const R = size * 0.46;
  const r = size * (kind === 'tray' ? 0.34 : 0.3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d <= R) {
        const insideDot = d <= r;
        img.setPixelColor(insideDot ? 0xaed8fcff : 0x16181dff, x, y);
      }
    }
  }
  return img;
}

/** Wrap PNGs at multiple sizes into a Windows .ico container. */
async function buildIco(iconSource) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    pngs.push({ size: s, buf: await (await renderSquare(iconSource, s)).getBuffer('image/png') });
  }
  const n = pngs.length;
  let offset = 6 + 16 * n;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(n, 4);
  const parts = [header];
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e[0] = p.size >= 256 ? 0 : p.size; // width
    e[1] = p.size >= 256 ? 0 : p.size; // height
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(p.buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.buf.length;
    parts.push(e);
  }
  for (const p of pngs) parts.push(p.buf);
  return Buffer.concat(parts);
}

async function main() {
  await mkdir(RAW, { recursive: true });
  const raws = (await readdir(RAW)).filter((f) => READABLE.test(f));

  // match raw files → slots
  const sources = new Map(); // slot file → Jimp image
  for (const raw of raws) {
    const which = SLOTS.filter((s) => s.match && s.match.test(raw) && !(s.avoid || []).some((a) => a.test(raw)));
    if (!which.length) {
      console.log(`  ? ${raw} — no slot matches (name it icon/logo/tray…) — ignored`);
      continue;
    }
    // largest matched slot wins the file; others reuse the same source
    const primary = which.find((w) => !w.preferLarge) || which[0];
    try {
      const img = await Jimp.read(await readFile(path.join(RAW, raw)));
      if (!sources.has(primary.file)) sources.set(primary.file, img);
      for (const w of which) if (!sources.has(w.file)) sources.set(w.file, img);
      console.log(`  + ${raw} → ${which.map((w) => w.file).join(', ')}`);
    } catch (e) {
      console.warn(`  ! ${raw} unreadable: ${e.message}`);
    }
  }

  const manifest = { generatedAt: new Date().toISOString(), slots: [] };

  for (const slot of SLOTS) {
    const outPath = path.join(ROOT, slot.file);
    await mkdir(path.dirname(outPath), { recursive: true });

    if (slot.derived === 'icon') {
      const src = sources.get('assets/icon.png') || (await placeholder(512, 'icon'));
      const buf = await buildIco(await renderSquare(src, 512));
      await writeFile(outPath, buf);
      manifest.slots.push(slotEntry(slot, buf.length, 'derived'));
      console.log(`  = assets/icon.ico (${buf.length} bytes, 7 sizes)`);
      continue;
    }

    // Fallback chain: this slot's own raw art → the icon's raw art → placeholder.
    const kind = /tray/.test(slot.file) ? 'tray' : 'icon';
    const fromRaw = sources.has(slot.file);
    const src =
      sources.get(slot.file) ||
      sources.get('assets/icon.png') ||
      (await placeholder(slot.size, kind));
    const buf = await encodeBudgeted(src, slot.size, slot.budget, slot.file);
    await writeFile(outPath, buf);
    const origin = fromRaw ? 'raw' : sources.has('assets/icon.png') ? 'icon-fallback' : 'placeholder';
    manifest.slots.push(slotEntry(slot, buf.length, origin));
    console.log(`  = ${slot.file} (${buf.length} bytes, ${slot.size}px, ${origin})`);
  }

  await writeFile(path.join(ROOT, 'assets', 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('  manifest → assets/manifest.json');
}

function slotEntry(slot, bytes, origin) {
  return {
    file: slot.file,
    canonicalSize: slot.size || '16–256 (ico)',
    budgetBytes: slot.budget || null,
    bytes,
    origin,
    naming: slot.match ? `raw filename matching ${slot.match}` : 'derived from icon.png',
  };
}

main().catch((e) => {
  console.error('normalize-assets failed:', e?.message || String(e));
  console.error(e?.stack || '');
  process.exit(1);
});
