'use strict';
/**
 * 把出包目录里的核心模块编译成 V8 字节码（.jsc），原 .js 换成一行加载壳
 * 用法：node pack-bytecode.js dist/XXT-A-v1.1.0
 */
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2];
if (!DIR || !fs.existsSync(DIR)) { console.log('用法：node pack-bytecode.js <出包目录>'); process.exit(1); }

const BT_DIR = path.join(__dirname, 'tools', 'bt', 'node_modules');
process.env.NODE_PATH = BT_DIR;
require('module').Module._initPaths();
const bytenode = require(path.join(BT_DIR, 'bytenode'));

// 入口脚本（有副作用，直接跑）
const ENTRIES = ['autopilot.js', 'xxt-bridge.js', 'multi.js', 'nanny.js'];
// 模块（要保留 module.exports）
const MODULES = [
  'license.js', 'guard.js', 'sentinel.js', 'cdpkit.js', 'maintenance.js',
  'vault.js', 'apikey.js', 'binding.js', 'save-cred.js', 'setup.js',
  'wait-login.js', 'accounts.js', 'faceguard.js', 'facecheck.js', 'faceflow.js',
  'preflight.js',
];

let ok = 0, fail = 0;
for (const name of ENTRIES.concat(MODULES)) {
  const src = path.join(DIR, name);
  if (!fs.existsSync(src)) { console.log('  跳过（不存在） ' + name); continue; }
  const jsc = src.replace(/\.js$/, '.jsc');
  try {
    bytenode.compileFile({ filename: src, output: jsc, compileAsModule: true });
    const isEntry = ENTRIES.indexOf(name) >= 0;
    let shim;
    if (name === 'license.js') {
      // 授权模块要保留命令行入口（授权申请.cmd 会调 node license.js show）
      shim = "require('./node_modules/bytenode');\n" +
        "const __m = require('./license.jsc');\n" +
        "if (require.main === module) {\n" +
        "  const a = String(process.argv[2] || '').toLowerCase();\n" +
        "  if (a === 'check') { console.log(JSON.stringify(__m.verify(process.argv[3] || 'a'), null, 2)); }\n" +
        "  else { console.log('本机机器码：' + __m.machineId()); const r = __m.verify(a === 'show' ? (process.argv[3] || 'a') : 'a'); console.log('授权状态：' + (r.ok ? '有效 —— ' + r.message : '无效 —— ' + r.message)); }\n" +
        "}\n" +
        "module.exports = __m;\n";
    } else if (isEntry) {
      shim = "require('./node_modules/bytenode');\nrequire('./" + path.basename(jsc) + "');\n";
    } else {
      shim = "require('./node_modules/bytenode');\nmodule.exports = require('./" + path.basename(jsc) + "');\n";
    }
    fs.writeFileSync(src, shim, 'utf8');
    ok++;
  } catch (e) {
    console.log('  编译失败 ' + name + '：' + e.message.split('\n')[0]);
    fail++;
  }
}

// 带上 bytenode 运行时
const btDst = path.join(DIR, 'node_modules', 'bytenode');
fs.mkdirSync(path.dirname(btDst), { recursive: true });
fs.cpSync(path.join(BT_DIR, 'bytenode'), btDst, { recursive: true });

console.log('  字节码：成功 ' + ok + '，失败 ' + fail);
