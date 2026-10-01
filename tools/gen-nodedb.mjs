/**
 * gen-nodedb.mjs —— 把参考项目 **Node Editor Pack（MIT）** 的 `node_data/data.json` 压成插件自带的节点词典。
 *
 * 为什么需要这个生成器：那份库是 **4.1 MB**（含 558 节点 / 274 枚举 / 94 枚举类型 + 大量英文说明），
 * 直接进 npm 包太大；插件真正要的是「**id → 中英名字 + 标识 + 系统 + 分类 + 端口**」。
 *
 * ⚠️ **许可与归属**：上游是 MIT（`Copyright 2025-2026 Wu-Yijun`，见 `参考项目/.../LICENSE`）。
 *    本生成器只做**字段挑选与压缩**，不改语义；归属写进 `NOTICE` 与产物头部的 `_source`。
 * ⚠️ **它是逆向整理的库**（`Schema: Skip`），7.1 逐条是否与游戏一致**未核** ⇒ 产物里带 `unverified` 提示。
 *
 * 用法：node tools/gen-nodedb.mjs [--ref <data.json 路径>] [--out lib/nodedb.json] [--check]
 *   `--check` 只校验"产物是否与上游同步"，不写盘（prepublish 用得上）。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, dft) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dft; };
const DEFAULT_REF = 'C:/Users/Administrator/Desktop/yuanshen/参考项目/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack-main/utils/node_data/data.json';
const ref = argOf('--ref', DEFAULT_REF);
const out = argOf('--out', path.resolve(import.meta.dirname, '..', 'lib', 'nodedb.json'));
const check = argv.includes('--check');

if (!fs.existsSync(ref)) {
  console.error('✗ 找不到上游节点库：' + ref);
  console.error('  它是**只读参考**（不在插件仓库里）⇒ 这个生成器只在"导库/更新库"时手工跑，不参与 npm test。');
  process.exit(2);
}
const d = JSON.parse(fs.readFileSync(ref, 'utf8'));
/**
 * 端口压成**元组** `[方向, 标签, 类型, shellIndex, 是否执行流]`（方向 i/o）。
 * 用对象写成 336 KB，用元组 ~150 KB —— 端口有 2824 个，这一层省下来最值。
 */
const pinsOf = (n) => [].concat(n.FlowPins || [], n.DataPins || []).map((p) => [
  p.Direction === 'In' ? 'i' : 'o',
  (p.Label && (p.Label['zh-Hans'] || p.Label.en)) || p.Identifier || '',
  p.Type || '',
  p.ShellIndex == null ? -1 : p.ShellIndex,
  !!(n.FlowPins || []).includes(p) ? 1 : 0,
]);

/** 节点条目：键名缩短（`i`=id / `z`=中文名 / `e`=英文名 / `k`=标识 / `r`=ref / `s`=系统 / `d`=分类 / `t`=类型 / `a`=别名 / `p`=端口）*/
const nodes = d.Nodes.map((n) => {
  const o = {
    i: n.ID,
    z: (n.InGameName && n.InGameName['zh-Hans']) || '',
    e: (n.InGameName && n.InGameName.en) || '',
    k: n.Identifier,
    r: n.__ref_id || '',
    s: n.System === 'Server' ? 'S' : 'C',
    d: n.Domain || '',
    t: n.Type || '',
    p: pinsOf(n),
  };
  if (Array.isArray(n.Alias) && n.Alias.length) o.a = n.Alias;
  return o;
});

const payload = {
  _source: {
    project: 'Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack',
    license: 'MIT',
    copyright: 'Copyright 2025-2026 Wu-Yijun',
    file: 'utils/node_data/data.json',
    dbVersion: d.Version,
    gameVersion: d.GameVersion,
    author: d.Author,
    date: d.Date,
    generatedBy: 'packages/dsh-miliastra/tools/gen-nodedb.mjs',
  },
  // ⚠️ 逆向整理的库；且**与 .gil 里的号不是一套**（见下）
  unverified: [
    '这份词典是**上游逆向整理**的（Schema: Skip）；其 GameVersion=' + d.GameVersion + '，与 7.1 是否逐条一致**未核**。',
    '⚠️ **`.gil` 里的节点声明 id 是"关卡内分配"的号（如 1073741843），与本词典的 `id`（≤300004）不是一套** —— '
      + '已把上游 ID / __ref_id / Alias / Implementation 及整份 JSON 搜过那些号，**一条都没命中** ⇒ 词典能回答'
      + '「官方有哪些节点、名字/端口叫什么」，**不能**把地图里的声明号翻成节点名。',
  ],
  systemConstants: d.SystemConstants || {},
  counts: {
    nodes: nodes.length,
    enums: (d.Enums || []).length,
    enumTypes: (d.EnumTypes || []).length,
    types: (d.Types || []).length,
    server: nodes.filter((n) => n.s === 'S').length,
    client: nodes.filter((n) => n.s === 'C').length,
    pins: nodes.reduce((s, n) => s + n.p.length, 0),
  },
  nodes,
};

const text = JSON.stringify(payload);
if (check) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  const same = cur.trim() === text.trim();
  console.log((same ? '✓' : '✗') + ' 节点库' + (same ? '已是最新' : '与上游**不同步**') + '（上游 ' + nodes.length + ' 条 / ' + (text.length / 1024).toFixed(1) + ' KB）');
  process.exit(same ? 0 : 1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, 'utf8');
console.log('✅ 已生成 ' + out);
console.log('   ' + nodes.length + ' 节点（服务端 ' + payload.counts.server + ' / 客户端 ' + payload.counts.client + '）· 端口 ' + payload.counts.pins
  + ' · 枚举 ' + payload.counts.enums + '（未收）· ' + (text.length / 1024).toFixed(1) + ' KB');
