/**
 * tools/live-render-check.mjs — 向**运行中的 Host** 要探针模板渲染结果，并当场结构校验。
 *
 * 为什么需要：`patchReload: live` **不会重新 import Host 模块**（实测），
 * 所以「磁盘上的模板是对的」不等于「跑着的 Host 发的模板是对的」。
 * 部署探针前先问一遍，避免把一段带语法错的模板投进沙箱（那会整段静默失效）。
 *
 * 用法: node tools/live-render-check.mjs [baseUrl] [模板名...]
 *   默认 http://127.0.0.1:3080
 */
import { lintLua, lintSummary } from '../lib/lualint.mjs';

const base = (process.argv[2] || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const only = process.argv.slice(3);

const post = async (name, args) => {
  const r = await fetch(base + '/miliastra/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const j = await r.json();
  if (!j || j.ok !== true) throw new Error('调用失败: ' + JSON.stringify(j).slice(0, 300));
  // 信封可能有三层：body{ok,data:{name,ok,data:<业务返回体>}}
  const d = j.data && j.data.data && typeof j.data.data === 'object' && !Array.isArray(j.data.data) ? j.data.data : j.data;
  return d && d.data && typeof d.data === 'object' && d.ok !== undefined ? d.data : d;
};

let fail = 0;
try {
  const st = await post('miliastra_echo', { text: 'live-render-check' });
  console.log('Host 在线，插件版本 ' + st.version + '，存档根 ' + st.localLow);
} catch (e) {
  console.log('❌ 连不上运行中的 Host（dsh web 没在跑？）：' + e.message);
  process.exit(1);
}

let templates;
try {
  const list = await post('miliastra_probe', { op: 'list' });
  templates = list.templates || [];
  console.log('Host 当前登记的模板: ' + templates.join(', '));
} catch (e) {
  console.log('❌ 取模板清单失败：' + e.message);
  process.exit(1);
}

const list = only.length ? only : templates;
for (const t of list) {
  if (!templates.includes(t)) {
    console.log('❌ ' + t.padEnd(14) + '运行中的 Host **没有**这个模板（磁盘上有也没用 —— 重启 dsh web 才会加载）');
    fail += 1;
    continue;
  }
  try {
    const r = await post('miliastra_probe', { op: 'render', template: t, tag: 'LIVECHECK' });
    const lr = lintLua(r.lua);
    console.log((lr.ok ? '  OK ' : 'FAIL ') + t.padEnd(14) + (r.bytes || r.lua.length) + 'B  ' + lintSummary(lr));
    if (!lr.ok) {
      fail += 1;
      const lines = r.lua.split(/\r?\n/);
      for (const p of lr.problems) {
        console.log('  ── L' + p.line + ' ' + p.message);
        for (let k = Math.max(1, p.line - 1); k <= Math.min(lines.length, p.line + 1); k++) {
          console.log('     ' + (k === p.line ? '>' : ' ') + String(k).padStart(4) + ' | ' + lines[k - 1]);
        }
      }
    }
    // 关键内容抽查：探针必须开 EnableUpdate，否则只会打三行空壳
    if (lr.ok && !/EnableUpdate\(true\)/.test(r.lua)) {
      console.log('  ⚠️ ' + t + ' 没有 EnableUpdate(true) —— OnUpdate 不会触发，只会打 OnInit/OnEnable/OnStart 三行空壳');
      fail += 1;
    }
  } catch (e) {
    console.log('❌ ' + t.padEnd(14) + '渲染失败：' + e.message);
    fail += 1;
  }
}

console.log('\n共 ' + list.length + ' 个模板，失败 ' + fail + ' 个');
process.exitCode = fail ? 1 : 0;
