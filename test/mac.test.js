'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { Jimp } = require('jimp');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

test('macOS builds ship a universal dmg + zip with the brand icon', () => {
  const cfg = yaml.load(read('electron-builder.yml').toString('utf8'));
  assert.deepStrictEqual(cfg.mac.target, ['dmg', 'zip']);
  assert.strictEqual(cfg.mac.icon, 'assets/icon.icns');
  assert.strictEqual(cfg.mac.category, 'public.app-category.productivity');
  assert.match(cfg.mac.artifactName, /\$\{arch\}/);
  assert.strictEqual(cfg.mac.hardenedRuntime, true);

  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['dist:mac'], /--mac\b/);
  assert.match(pkg.scripts['dist:mac'], /--universal\b/);
});

test('icon.icns is a valid container with the modern PNG size ladder', () => {
  const buf = read('assets/icon.icns');
  assert.strictEqual(buf.toString('ascii', 0, 4), 'icns');
  assert.strictEqual(buf.readUInt32BE(4), buf.length);

  const types = [];
  let off = 8;
  while (off < buf.length) {
    assert.ok(off + 8 <= buf.length, 'truncated icns entry header');
    types.push(buf.toString('ascii', off, off + 4));
    const len = buf.readUInt32BE(off + 4);
    assert.ok(len >= 8, 'icns entry smaller than its header');
    assert.ok(off + len <= buf.length, 'icns entry runs past the container');
    off += len;
  }
  assert.strictEqual(off, buf.length);
  for (const type of ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) {
    assert.ok(types.includes(type), `missing ${type}`);
  }
});

test('menu bar template icons are black + alpha at 1x and 2x', async () => {
  for (const [file, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    const img = await Jimp.read(path.join(ROOT, 'assets', file));
    assert.strictEqual(img.width, size, file);
    assert.strictEqual(img.height, size, file);
    let visible = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = img.getPixelColor(x, y);
        if (px & 0xff) {
          visible++;
          assert.strictEqual(px >>> 8, 0, `${file} has a non-black pixel at ${x},${y}`);
        }
      }
    }
    assert.ok(visible > 0, `${file} is empty`);
  }
});
