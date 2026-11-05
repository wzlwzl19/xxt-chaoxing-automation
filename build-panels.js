// build-panels.js —— 由同一份模板生成 A / B / C 三套面板
//
// 为什么不做三份独立文件手工维护：
//   三份手写必然漂移（改了 A 忘了 C），最后 B 版少个字段、C 版多点判断，
//   排查成本极高。所以保留唯一模板 dsh-plugin/lib/panel.js，
//   只改 VER 这一行生成三份产物，逻辑 100% 一致，差异只在"能不能选数量、上限几台"。
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const LIB = path.join(DIR, 'dsh-plugin', 'lib');
const TEMPLATE = path.join(LIB, 'panel.js');

const VERSIONS = {
  a: {
    key: 'a',
    title: 'A 版 · 一机一号',
    maxSlots: 1,
    showCount: false,
    countLabel: '账号数量',
    hint: '一机一号：只开一个窗口，只刷一个账号',
  },
  b: {
    key: 'b',
    title: 'B 版 · 一机三号',
    maxSlots: 3,
    showCount: true,
    countLabel: '账号数量（最多三台）',
    hint: '1~3 个窗口，每窗一个账号、各自独立登录',
  },
  c: {
    key: 'c',
    title: 'C 版 · 一机六号',
    maxSlots: 6,
    showCount: true,
    countLabel: '账号数量（最多六台）',
    hint: '1~6 个窗口，每窗一个账号、各自独立登录',
  },
};

const VER_LINE = /^\s*var VER = \{.*\};$/m;

function build(key) {
  const cfg = VERSIONS[key];
  if (!cfg) throw new Error('未知版本：' + key);
  const src = fs.readFileSync(TEMPLATE, 'utf8');
  if (!VER_LINE.test(src)) throw new Error('模板里找不到 var VER 行，无法生成版本');
  const line = '  var VER = ' + JSON.stringify(cfg) + ';';
  const out = src.replace(VER_LINE, line);
  const file = path.join(LIB, 'panel.' + key + '.js');
  fs.writeFileSync(file, out, 'utf8');
  return { file, cfg, bytes: Buffer.byteLength(out) };
}

function main() {
  const keys = process.argv.slice(2).filter((k) => VERSIONS[k]);
  const targets = keys.length ? keys : Object.keys(VERSIONS);
  for (const k of targets) {
    const r = build(k);
    console.log('[OK] panel.' + k + '.js  ' + r.bytes + ' B  ' + r.cfg.title +
      '  maxSlots=' + r.cfg.maxSlots + '  showCount=' + r.cfg.showCount);
  }
}

if (require.main === module) main();
module.exports = { VERSIONS, build };
