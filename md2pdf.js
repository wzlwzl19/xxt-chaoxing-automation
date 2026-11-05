'use strict';
/**
 * md2pdf.js —— 用 Edge 无头模式把 Markdown 打成 PDF（无需装任何东西）
 * 用法：node md2pdf.js 合规审查报告.md [输出.pdf]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inList = false;

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      closeList();
      out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      closeList();
      const header = line.split('|').slice(1, -1).map(c => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
        i++;
      }
      let t = '<table><thead><tr>' + header.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows) t += '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
      t += '</tbody></table>';
      out.push(t);
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = h[1].length;
      out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }

    // 引用
    if (/^>\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + body.map(b => inline(b)).join('<br>') + '</blockquote>');
      continue;
    }

    // 列表
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
      i++;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inList) { out.push('<ul class="num">'); inList = true; }
      out.push('<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>');
      i++;
      continue;
    }

    // 空行
    if (!line.trim()) { closeList(); i++; continue; }

    // 段落
    closeList();
    out.push('<p>' + inline(line) + '</p>');
    i++;
  }
  closeList();
  return out.join('\n');
}

const CSS = `
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei","PingFang SC",-apple-system,sans-serif; color:#222; line-height:1.75;
       max-width: 900px; margin: 0 auto; padding: 32px 36px; font-size: 12.5pt; }
h1 { font-size: 24pt; border-bottom: 3px solid #ef6f9c; padding-bottom: 8px; margin: 0 0 18px; color:#b1567f; }
h2 { font-size: 16pt; margin: 26px 0 10px; color:#b1567f; border-left: 5px solid #ff9dbd; padding-left: 10px; }
h3 { font-size: 13.5pt; margin: 18px 0 8px; color:#8a3f61; }
p { margin: 8px 0; }
table { width:100%; border-collapse: collapse; margin: 12px 0; font-size: 11pt; }
th, td { border: 1px solid #e6c7d5; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #fdeef4; color:#8a3f61; }
tr:nth-child(even) td { background: #fdf8fa; }
code { background: #f4f0f2; padding: 1px 4px; border-radius: 3px; font-size: 10.5pt; font-family: Consolas,monospace; }
pre { background: #faf5f7; border:1px solid #f0dae3; border-radius:6px; padding:10px 12px; overflow:auto; }
pre code { background:none; }
blockquote { border-left: 4px solid #ffb3cc; margin: 10px 0; padding: 6px 14px; background:#fff7fa; color:#5d4b55; }
ul { margin: 6px 0 6px 22px; } li { margin: 3px 0; }
hr { border:none; border-top:1px solid #f0dae3; margin: 18px 0; }
a { color:#b1567f; }
@page { margin: 16mm 14mm; }
`;

const args = process.argv.slice(2);
if (!args.length) {
  console.log('用法: node md2pdf.js <输入.md> [输出.pdf]');
  process.exit(1);
}
const src = path.resolve(args[0]);
const name = path.basename(src).replace(/\.md$/i, '');
const pdf = path.resolve(args[1] || path.join(path.dirname(src), name + '.pdf'));
const html = path.join(path.dirname(src), '.pdf-' + name + '.html');

const md = fs.readFileSync(src, 'utf8');
fs.writeFileSync(html,
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(name) + '</title><style>' + CSS + '</style></head><body>' +
  mdToHtml(md) + '</body></html>', 'utf8');

try {
  execFileSync(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--print-to-pdf=' + pdf,
    'file:///' + html.replace(/\\/g, '/'),
  ], { stdio: 'ignore', timeout: 120000 });
} catch (e) {
  console.log('PDF 生成失败: ' + e.message);
  process.exit(1);
}

const ok = fs.existsSync(pdf);
console.log((ok ? 'PDF 已生成: ' : '未生成: ') + pdf + (ok ? '（' + fs.statSync(pdf).size + ' B）' : ''));
try { fs.unlinkSync(html); } catch (e) { }
