// install-dsh-plugin.js —— 把 dsh-panel-xuexitong 写进 DSH profile 的 package.json（幂等）
'use strict';
const fs = require('fs');
const path = require('path');

const PROF = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'profiles', 'desktop');
const PKG = path.join(PROF, 'package.json');
const NAME = 'dsh-panel-xuexitong';
const PKG_DIR = path.join(PROF, 'node_modules', NAME);

if (!fs.existsSync(PKG)) {
  console.error('[X] 找不到 ' + PKG);
  process.exit(1);
}
if (!fs.existsSync(PKG_DIR)) {
  console.error('[X] 找不到插件目录 ' + PKG_DIR);
  process.exit(1);
}

const raw = fs.readFileSync(PKG, 'utf8').replace(/^\uFEFF/, '');
let j;
try { j = JSON.parse(raw); } catch (e) {
  console.error('[X] package.json 解析失败：' + e.message);
  process.exit(1);
}

j.dependencies = j.dependencies || {};
j.dependencies[NAME] = 'file:' + PKG_DIR;
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
j.dsh.profile.bundles = Array.isArray(j.dsh.profile.bundles) ? j.dsh.profile.bundles : [];
if (j.dsh.profile.bundles.indexOf(NAME) === -1) j.dsh.profile.bundles.push(NAME);

fs.writeFileSync(PKG, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log('     OK -> bundles: ' + j.dsh.profile.bundles.join(', '));

// 关键：光有 bundles + node_modules 目录不会被加载，必须把 insert 写进 cordis.patch.yml（幂等）
const PATCH = path.join(PROF, 'cordis.patch.yml');
if (!fs.existsSync(PATCH)) {
  console.error('[X] 找不到 ' + PATCH);
  process.exit(1);
}
let y = fs.readFileSync(PATCH, 'utf8');
if (y.indexOf('dsh-panel-xuexitong') === -1) {
  const block = '\n# —— 学习通刷课侧边栏面板（本地插件，包在 node_modules/dsh-panel-xuexitong）——\n- insert:\n    - id: dsh-panel-xuexitong\n      name: dsh-panel-xuexitong\n';
  fs.appendFileSync(PATCH, block, 'utf8');
  console.log('     OK -> cordis.patch.yml 已追加 insert');
} else {
  console.log('     OK -> cordis.patch.yml 已包含 insert');
}
