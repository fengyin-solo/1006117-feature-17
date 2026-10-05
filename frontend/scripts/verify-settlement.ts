/**
 * 沉降领域逻辑端到端验证（node 直跑，不依赖浏览器）。
 * 用内存版 local-store 桩替换持久化，覆盖：排期/重试/不顶上一轮/异常记账/
 * 整区空态/同日幂等/断点续跑/报警口径一致/权限。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 桩：localStorage + window ──
const memStore = new Map<string, string>()
const storeImpl = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, String(v)),
  removeItem: (k: string) => void memStore.delete(k),
}
;(globalThis as Record<string, unknown>).window = { localStorage: storeImpl }
;(globalThis as Record<string, unknown>).localStorage = storeImpl

const esbuild = await import('esbuild')
const dir = mkdtempSync(join(tmpdir(), 'settle-test-'))
const entry = join(dir, 'entry.mjs')
writeFileSync(entry, `export * from '/workspace/frontend/src/api/settlement-service.ts'`)
const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  alias: { '@': '/workspace/frontend/src' },
})
const bundled = join(dir, 'bundle.mjs')
writeFileSync(bundled, result.outputFiles[0].text)
const svc = await import(`file://${bundled}`)

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

const T = '2026-10-05'

// 1) 排期：种子读数只到 10-04，今天（10-05）所有非稳定测点都到期；
//    顺序：到期日早的先（B区应测日10-04逾期优先），同日按测点编号升序
const due = svc.listDuePoints(T).map((p: { 测点编号: string }) => p.测点编号)
console.log('待补测队列:', due.join(', '))
check('A区测点今日到期（读数只到昨天）', ['SETT-0001', 'SETT-0002', 'SETT-0003'].every((c: string) => due.includes(c)))
check('B区3个测点逾期（应测日10-04）待补', ['SETT-0004', 'SETT-0005', 'SETT-0006'].every((c: string) => due.includes(c)))
check('C区3个测点今日到期待补', ['SETT-0007', 'SETT-0008', 'SETT-0009'].every((c: string) => due.includes(c)))
check('补测顺序：到期日早的先、同日编号升序',
  JSON.stringify(due) === JSON.stringify(['SETT-0004', 'SETT-0005', 'SETT-0006', 'SETT-0001', 'SETT-0002', 'SETT-0003', 'SETT-0007', 'SETT-0008', 'SETT-0009']))

// 2) 整区空态：读数只到昨天，今晨还没测 → A/B/C 都应判「未测量」
const bZone = svc.zoneStatusOf('B区', T)
check('B区判为未测量（不是没取到）', bZone.state === '未测量', bZone.reason)
const aZone0 = svc.zoneStatusOf('A区', T)
check('A区今晨未测量', aZone0.state === '未测量', aZone0.reason)

// 3) A区单点点测：脚本要求第1次失败、第2次成功；成功前主台账累计沉降不被顶
const before1 = svc.listPointViews(T).find((p: { id: number }) => p.id === 1)
const keep = before1.累计沉降
const out1 = await svc.collectPoint(1, T, 'tester')
check('SETT-0001 重试2次后成功', out1.ok && out1.attempts === 2, out1.message)
const after1 = svc.listPointViews(T).find((p: { id: number }) => p.id === 1)
check('成功后累计沉降刷新为今日读数', after1.采集状态 === '已采集' && Number(after1.今日累计沉降) === 0.5)
check('取数期间上一轮累计沉降未被覆盖（旧值为 -4.1）', keep === -4.1)

// 4) C区整区取数，一轮全部失败 → 当场记异常、状态「未取到」（而不是停在加载/误报未测量）
const zoneC = await svc.collectZoneOnce('C区', T, 'tester')
check('C区本轮3点全部失败', zoneC.results.every((r: { ok: boolean }) => !r.ok))
check('C区整区交代为「未取到」', zoneC.zoneStatus.state === '未取到', zoneC.zoneStatus.reason)
check('整区失败当场记3条异常并写明原因',
  svc.listAllReadings().filter((r: { 测区: string; 监测日期: string; 采集状态: string }) =>
    r.测区 === 'C区' && r.监测日期 === T && r.采集状态 === '取数异常').length === 3)

// 5) 对已记异常的测点再「重试取数」：脚本3次全败 → 仍是同一条异常（不翻倍），原因刷新，主台账累计沉降不动
const failOut = await svc.collectPoint(7, T, 'tester')
check('SETT-0007 重试3次仍失败', !failOut.ok && failOut.attempts === 3, failOut.message)
check('异常读数写明原因', failOut.reading.采集状态 === '取数异常' && failOut.reading.异常原因.includes('重试3次仍失败'))
check('重试不翻倍：C区今日仍是3条读数',
  svc.listAllReadings().filter((r: { 测区: string; 监测日期: string }) => r.测区 === 'C区' && r.监测日期 === T).length === 3)
const p7 = svc.listPointViews(T).find((p: { id: number }) => p.id === 7)
check('失败后主台账累计沉降仍为上一轮 -1.5', Number(p7.累计沉降) === -1.5)
const cZoneNow = svc.zoneStatusOf('C区', T)
check('C区状态保持「未取到」', cZoneNow.state === '未取到')

// 6) 同日重复提交幂等
const readingsBefore = svc.listAllReadings().length
await svc.collectPoint(1, T, 'tester')
const dup = svc.submitManualReading({ pointId: 1, date: T, elevationText: '5.1285' })
check('再次取数/补录不翻倍（同日只一条）', dup.ok && svc.listAllReadings().length === readingsBefore, dup.message)

// 7) 人工补录：非法高程原样退回
const bad = svc.submitManualReading({ pointId: 4, date: T, elevationText: '9.999' })
check('高程离初始值过远被拒且原样退回', !bad.ok && bad.returned && bad.returned.elevationText === '9.999', bad.message)
const badNum = svc.submitManualReading({ pointId: 4, date: T, elevationText: 'abc' })
check('非数字高程原样退回', !badNum.ok && badNum.returned.elevationText === 'abc')
const ok4 = svc.submitManualReading({ pointId: 4, date: T, elevationText: '4.871' })
check('合法补录成功', ok4.ok, ok4.message)

// 8) 补测批次断点续跑：先跑2点中断，再继续，已完成不重测
svc.setCurrentRole('监测负责人')
const started = svc.startBatch('ALL', T)
check('建立批次', started.ok, started.message)
const bid = started.batch.id
await svc.advanceBatch(bid, T)
await svc.advanceBatch(bid, T)
const snapshot0 = svc.listBatchesView().find((b: { id: number }) => b.id === bid)
const doneAtInterrupt = [...snapshot0.完成测点]
svc.interruptBatch(bid)
const inter = svc.listBatchesView().find((b: { id: number }) => b.id === bid)
check('中断状态可识别', inter.状态 === '已中断')
const resumed = svc.resumeBatch(bid)
check('中断批次可恢复为进行中', resumed.ok, resumed.message)
const finalBatch = await svc.runBatchToEnd(bid, T)
check('续跑覆盖全部计划测点', finalBatch.完成测点.length === finalBatch.计划测点.length)
check('测点不重复（成功+异常=计划数，无重复id）',
  new Set([...finalBatch.成功测点, ...finalBatch.异常测点]).size === finalBatch.计划测点.length)
check('中断前完成的2点仍在完成清单最前', doneAtInterrupt.every((id: number, i: number) => finalBatch.完成测点[i] === id))
check('C区3点最终都记异常', finalBatch.异常测点.length >= 3)

// 9) 报警口径一致：settlementStats 与建筑页读到的 alarmByBuilding 同一份
const stats = svc.settlementStats(T)
const alarmCodes = svc.listPointViews(T).filter((p: { status: string }) => p.status === '报警').map((p: { 测点编号: string }) => p.测点编号)
check('种子已有2个报警测点（SETT-0002/03）', stats.alarmPoints >= 2, `alarm=${stats.alarmPoints} codes=${alarmCodes}`)
const b1 = stats.alarmByBuilding.find((x: { code: string }) => x.code === 'BUIL-0001')
check('建筑对象 BUIL-0001 汇总到2个报警测点', b1 && b1.alarm === 2, JSON.stringify(b1))

// 10) 权限：值班管理员不能改阈值/初始高程
svc.setCurrentRole('值班管理员')
check('值班管理员无基线修改权', svc.canEditBaseline() === false)
const denied = svc.updateBaseline(1, { 预警阈值: -30 })
check('越权修改被拒绝', !denied.ok, denied.message)
svc.setCurrentRole('监测负责人')
const allowed = svc.updateBaseline(1, { 预警阈值: -30 })
check('负责人可修改阈值', allowed.ok, allowed.message)
const back = svc.updateBaseline(1, { 预警阈值: -20 })
check('阈值改回后重新判定不报警', back.ok)

// 11) 新测点登记：布点日期必填、编号唯一；存量按布点进台账（逾期即待补）
const noDate = svc.registerPoint({ code: 'SETT-X1', location: 'x', zone: 'D区', baseElevationText: '5.0', thresholdText: '-20', rateThresholdText: '-3', frequency: '1次/天', deployDate: '', buildingCode: '', buildingName: '' })
check('布点日期必填', !noDate.ok && noDate.returned, noDate.message)
const reg = svc.registerPoint({ code: 'SETT-0100', location: 'D区-点', zone: 'D区', baseElevationText: '5.0', thresholdText: '-20', rateThresholdText: '-3', frequency: '1次/天', deployDate: '2026-10-01', buildingCode: 'BUIL-0002', buildingName: '老配电房' })
check('存量测点按布点日期登记成功', reg.ok, reg.message)
const dupCode = svc.registerPoint({ code: 'SETT-0100', location: 'y', zone: 'D区', baseElevationText: '5.0', thresholdText: '-20', rateThresholdText: '-3', frequency: '1次/天', deployDate: '2026-10-01', buildingCode: '', buildingName: '' })
check('测点编号不可重复', !dupCode.ok, dupCode.message)
const newDue = svc.listDuePoints(T).some((p: { 测点编号: string }) => p.测点编号 === 'SETT-0100')
check('布点日期早于今天的新测点直接进入待补测', newDue)

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
