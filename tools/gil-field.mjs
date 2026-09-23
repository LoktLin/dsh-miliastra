/**
 * tools/gil-field.mjs — 把 `.gil` 里**指定的顶层字段**展开看（限深度，免得刷屏）。
 *
 * 用途：`.gil` 有 45 个顶层字段，代码只读了其中 5 个（关卡/名字/账号/版本/脚本/客户端控件）。
 * 想知道「还有哪些东西躺在里面」就用这个挨个看。
 *
 * 用法: node tools/gil-field.mjs <gil路径> <字段号列表,逗号分隔> [深度，默认4]
 *   node tools/gil-field.mjs x.gil 10,15,29
 */
import fs from 'node:fs';
import path from 'node:path';
import { findProtobufRoot, fieldsAll } from '../lib/wire.mjs';

const [file, nums, depthArg] = process.argv.slice(2);
if (!file || !nums) {
  console.log('用法: node tools/gil-field.mjs <gil路径> <字段号,逗号分隔> [深度]');
  process.exit(1);
}
const MAXD = Number(depthArg || 4);
const want = String(nums).split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n));

const buf = fs.readFileSync(file);
const rootInfo = findProtobufRoot(buf);
if (!rootInfo) { console.log('解析失败：不是可识别的 protobuf 形态'); process.exit(1); }
const root = rootInfo.fields;

/** 把 bytes 尽量当 UTF-8 看（含中文/可打印字符才算文本） */
function asText(bytes) {
  const s = Buffer.from(bytes).toString('utf8');
  return (s && !s.includes('\uFFFD') && /[\x20-\x7e\u4e00-\u9fff]{2,}/.test(s)) ? s : null;
}

/** 可读叶子：尽量把 bytes 当 UTF-8 看 */
function leaf(f) {
  if (f.wt === 0) return 'varint = ' + f.value;
  if (f.wt === 1) return 'fixed64 = ' + f.value;
  if (f.wt === 5) return 'fixed32 = ' + f.value;
  if (f.wt === 2) {
    const s = asText(f.value);
    if (s) return 'str = ' + JSON.stringify(s.slice(0, 80));
    return 'bytes[' + f.value.length + '] = ' + Buffer.from(f.value).slice(0, 16).toString('hex');
  }
  return 'wt' + f.wt;
}

let total = 0;
for (const n of want) {
  const list = fieldsAll(root, n);
  console.log('\n===== #' + n + '（' + list.length + ' 个）=====');
  if (!list.length) { console.log('  （没有这个字段）'); continue; }
  for (const f of list) {
    if (f.wt !== 2 || !f.sub) { console.log('  ' + leaf(f)); continue; }
    console.log('  msg(' + f.value.length + 'B)，子字段 ' + f.sub.length + ' 个');
    total += f.sub.length;
    const walk = (fields, d, prefix) => {
      if (d > MAXD) { console.log(prefix + '…（更深，省略）'); return; }
      for (const g of fields) {
        if (g.wt === 2 && g.sub) {
          const s = asText(g.value);
          console.log(prefix + '#' + g.no + ' msg(' + g.value.length + 'B) 子=' + g.sub.length + (s ? '  ' + JSON.stringify(s.slice(0, 70)) : ''));
          walk(g.sub, d + 1, prefix + '  ');
        } else {
          console.log(prefix + '#' + g.no + ' ' + leaf(g));
        }
      }
    };
    walk(f.sub, 1, '    ');
  }
}
