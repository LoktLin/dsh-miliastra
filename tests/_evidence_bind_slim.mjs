/**
 * 一次性取证脚本（**不是测试套件**，不进 test-all 的 SUITES）：
 * 给「反馈第 2/4/11 条」这一段改动留实测数字 —— 同一份 bind 的**精简档 vs 全文**字节数、
 * 精简档里 `controlCount` / `logs` 还在不在、`runForMs` 折算成几帧、推 1800 帧要多久。
 *
 * 用法：node tests/_evidence_bind_slim.mjs
 * 跑完自己删（或者留着也行：`_` 开头，lint/死导出与 test-all 都不扫它）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-evidence-'));
process.env.MILIASTRA_DATA_DIR = tmpData;
process.env.QXQY_PLAY_TIMEOUT_MS = '60000';

const { simOp, disposeSimAll, normalizeRunForMs } = await import('../lib/sim.mjs');

const lua = path.join(tmpData, '取证.lua');
fs.writeFileSync(lua, [
  'local n = 0',
  'function OnStart()',
  '  script:EnableUpdate(true)',
  '  print("[取证] ready")',
  'end',
  'function OnUpdate(dt)',
  '  n = n + 1',
  '  if n % 300 == 0 then print("[取证] ticks=" .. tostring(n)) end',
  'end',
  '',
].join('\n'), 'utf8');

const T = [{ guid: 1073741868, kind: 'image', name: '图片模板' }];

const slim = await simOp({ op: 'bind', source: lua, runForMs: 2000, templates: T });
const full = await simOp({ op: 'bind', source: lua, runForMs: 2000, templates: T, withMeta: true });

const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
console.log('=== 1) 同一份 bind：精简档 vs withMeta 全文 ===');
console.log('slim bytes =', bytes(slim));
console.log('full bytes =', bytes(full));
console.log('省了 =', bytes(full) - bytes(slim), 'B  (' + (100 * (1 - bytes(slim) / bytes(full))).toFixed(0) + '%)');
console.log('slim 有 run.controlCount =', Number(slim.run.controlCount), '| run.logs 条数 =', slim.run.logs.length,
  '| lua-error 条数 =', slim.run.logs.filter((l) => l.level === 'lua-error').length);
console.log('slim 有 handover.missing =', JSON.stringify(slim.handover.missing), '| nextStep =', !!slim.nextStep, '| recipe =', !!slim.recipe);
console.log('slim 里 sources/scripts/simAssumptions =',
  slim.sources === undefined, slim.scripts === undefined, slim.simAssumptions === undefined,
  '| simAssumptionsCount =', slim.simAssumptionsCount);
console.log('slim.omitted =', JSON.stringify(slim.omitted));
console.log('full 里 sources 条数 =', full.sources.length, '| scripts 条数 =', full.scripts.length,
  '| simAssumptions 条数 =', full.simAssumptions.length);
console.log('slim 的 key =', JSON.stringify(Object.keys(slim)));
console.log('logScopeNote =', slim.logScopeNote);

console.log('\n=== 2) runForMs ===');
console.log('run.runForMs =', slim.run.runForMs, '| framesAdvanced =', slim.run.framesAdvanced, '| time =', slim.run.time);
console.log('runMode =', slim.run.runMode);
console.log('normalizeRunForMs(60001) =', JSON.stringify(normalizeRunForMs(60001)));
console.log('normalizeRunForMs(0) =', JSON.stringify(normalizeRunForMs(0)));
console.log('normalizeRunForMs(undefined) =', JSON.stringify(normalizeRunForMs(undefined)));

console.log('\n=== 3) 上限真的跑 60000ms（1800 帧）要多久 ===');
const t0 = Date.now();
const big = await simOp({ op: 'bind', source: lua, runForMs: 999999, templates: T });
console.log('runForMs =', big.run.runForMs, '| runForMsClamped =', big.run.runForMsClamped,
  '| runForMsRequested =', big.run.runForMsRequested, '| framesAdvanced =', big.run.framesAdvanced,
  '| time =', big.run.time, '| 墙钟 =', ((Date.now() - t0) / 1000).toFixed(2) + 's');
console.log('1800 帧下的 print 行 =', JSON.stringify(big.run.logs.map((l) => l.text)));

console.log('\n=== 4) op=play action=step 的三档语义 ===');
await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
const s1 = await simOp({ op: 'play', action: 'step', args: { dt: 16 } });
console.log('[只 dt:16] frame=' + s1.frame + ' time=' + s1.time + '\n  note=' + s1.note);
const s2 = await simOp({ op: 'play', action: 'step', args: { frames: 45 } });
console.log('[只 frames:45] frame=' + s2.frame + ' time=' + s2.time + '\n  note=' + s2.note);
const s3 = await simOp({ op: 'play', action: 'step', args: { frames: 45, dt: 3 } });
console.log('[frames:45 + dt:3] frame=' + s3.frame + ' time=' + s3.time + '\n  note=' + s3.note);
await simOp({ op: 'play', action: 'stop' });

await disposeSimAll();
fs.rmSync(tmpData, { recursive: true, force: true });
