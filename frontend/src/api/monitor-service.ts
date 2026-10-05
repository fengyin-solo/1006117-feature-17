import { MODULE_BY_KEY } from '@/data/modules'
import { listRows, saveRows } from '@/data/local-store'
import { readMonitorAux, writeMonitorAux } from '@/data/monitor-store'
import type {
  Actor,
  AreaEvent,
  AreaStatus,
  BatchProgress,
  FetchFailure,
  MonitorAux,
  MonitoringSummary,
  ObjectView,
  PointDerived,
  PointView,
  ReadingInput,
  ScenarioSpec,
  SettlementReading,
  SubmitReadingResult,
} from '@/data/types'
import type { EntryRow } from '@/data/types'

// ============================================================================
// 地表沉降监测域服务
//
// 口径约定（全项目唯一）：
// 1) 沉降测点主记录（settlement 模块）+ 读数明细（monitor-store）是唯一事实来源，
//    建筑监测页、运营概览的报警测点/报警对象都从 getMonitoringSummary 同源派生，
//    不在建筑页另记一份。
// 2) 处理顺序：排期判定 → 整区探针 → 逐点取数(1取2重试) → 幂等落库 → 越限判定 → 同源呈现。
// 3) 取数失败只登记异常，绝不用失败结果顶替上一轮累计沉降/速率/最近监测。
// ============================================================================

const TODAY = '2026-10-05' // 演示环境的“今天”，与种子数据对齐
const SETTLEMENT_KEY = 'settlement'
const BUILDING_KEY = 'building'

// ---- 日期工具 ---------------------------------------------------------------

function parseDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

function toText(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(value: string, days: number): string {
  const date = parseDate(value)
  date.setDate(date.getDate() + days)
  return toText(date)
}

function diffDays(from: string, to: string): number {
  const ms = parseDate(to).getTime() - parseDate(from).getTime()
  return Math.round(ms / 86400000)
}

export function today(): string {
  return TODAY
}

// “1次/天”“1次/2天”“1次/7天” → 间隔天数。
export function frequencyDays(freq: string): number {
  const matched = /(\d+)\s*天/.exec(freq)
  if (matched) {
    return Number(matched[1])
  }
  return /小时/.test(freq) ? 1 : 1
}

function hashText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

// ---- 行读取（沿用既有 local-store 读取方式，不另开通道） ---------------------

function pointRows(): EntryRow[] {
  return listRows(SETTLEMENT_KEY)
}

function objectRows(): EntryRow[] {
  return listRows(BUILDING_KEY)
}

function numberField(row: EntryRow, field: string): number {
  const value = Number(row[field])
  return Number.isFinite(value) ? value : 0
}

function textField(row: EntryRow, field: string): string {
  return String(row[field] ?? '')
}

function findReading(aux: MonitorAux, pointCode: string, measureDate: string): SettlementReading | undefined {
  return aux.readings.find((item) => item.pointCode === pointCode && item.measureDate === measureDate)
}

function latestReading(aux: MonitorAux, pointCode: string): SettlementReading | undefined {
  const own = aux.readings
    .filter((item) => item.pointCode === pointCode)
    .sort((a, b) => (a.measureDate < b.measureDate ? 1 : -1))
  return own[0]
}

function openFailure(aux: MonitorAux, pointCode: string): FetchFailure | undefined {
  return aux.failures.find((item) => item.pointCode === pointCode && !item.resolved)
}

// ---- 排期与状态派生 ----------------------------------------------------------

function schedule(row: EntryRow, aux: MonitorAux): Pick<PointDerived, 'nextDueDate' | 'latestDate' | 'due' | 'overdueDays'> {
  const freq = frequencyDays(textField(row, '监测频次'))
  const deployDate = textField(row, '布点日期')
  const latest = latestReading(aux, textField(row, '测点编号'))
  const latestDate = latest?.measureDate ?? ''
  // 首次应测 = 布点日期 + 频次；之后每次应测 = 最近监测 + 频次。
  const nextDueDate = deployDate ? addDays(latestDate || deployDate, freq) : ''
  const overdue = nextDueDate ? diffDays(nextDueDate, TODAY) : 0
  return {
    nextDueDate,
    latestDate,
    due: overdue >= 0 && Boolean(nextDueDate),
    overdueDays: Math.max(overdue, 0),
  }
}

export function derivePoint(row: EntryRow, aux: MonitorAux, objects?: Map<string, EntryRow>): PointDerived {
  const code = textField(row, '测点编号')
  const latest = latestReading(aux, code)
  const failure = openFailure(aux, code)
  const sched = schedule(row, aux)

  // 越限判定只认测点自己的「预警阈值 / 速率限值」（只有监测负责人能改）；
  // 所属对象的「允许沉降」只用于建筑页展示与报警归属，不在这里顶替测点阈值，
  // 否则负责人改了测点阈值会不生效。objects 入参保留给归属汇总复用。
  void objects
  const reasons: string[] = []
  const cumulativeLimit = numberField(row, '预警阈值')
  const rateLimit = numberField(row, '速率限值')
  const cumulative = latest?.cumulative ?? numberField(row, '累计沉降')
  const rate = latest?.rate ?? numberField(row, '沉降速率')
  if (cumulativeLimit > 0 && cumulative >= cumulativeLimit) {
    reasons.push(`累计沉降 ${cumulative.toFixed(1)}mm ≥ 限值 ${cumulativeLimit}mm`)
  }
  if (rateLimit > 0 && rate >= rateLimit) {
    reasons.push(`沉降速率 ${rate.toFixed(1)}mm/d ≥ 限值 ${rateLimit}mm/d`)
  }
  const alarm = reasons.length > 0 && row.status !== '已稳定'

  // 状态优先级：已稳定 > 报警 > 取数异常（有未闭环异常）> 到期待补测 > 正常。
  let status: PointDerived['status'] = '正常'
  if (row.status === '已稳定') {
    status = '已稳定'
  } else if (alarm) {
    status = '报警'
  } else if (failure) {
    status = '取数异常'
  } else if (sched.due) {
    status = '待补测'
  }

  return {
    status,
    due: sched.due,
    overdueDays: sched.overdueDays,
    alarm,
    alarmReasons: reasons,
    openFailure: failure,
    latestReading: latest,
    nextDueDate: sched.nextDueDate,
    latestDate: sched.latestDate,
  }
}

// ---- 对外只读视图（两页 + 概览共用，杜绝各算一遍） ---------------------------

export function listPointViews(filters: Record<string, string> = {}): { items: PointView[]; total: number } {
  const aux = readMonitorAux()
  const objects = new Map(objectRows().map((item) => [textField(item, '对象编号'), item]))
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const items = pointRows()
    .map((row) => ({ row, derived: derivePoint(row, aux, objects) }))
    .filter(({ row, derived }) => {
      if (pairs.length === 0) {
        return true
      }
      return pairs.every(([field, value]) => {
        const keyword = value.trim()
        if (field === '状态') {
          return derived.status.includes(keyword)
        }
        return String(row[field] ?? '').includes(keyword)
      })
    })
  return { items, total: items.length }
}

export function listObjectViews(): ObjectView[] {
  const aux = readMonitorAux()
  const objects = new Map(objectRows().map((item) => [textField(item, '对象编号'), item]))
  const byObject = new Map<string, PointView[]>()
  for (const row of pointRows()) {
    const view = { row, derived: derivePoint(row, aux, objects) }
    const owner = textField(row, '所属对象')
    const list = byObject.get(owner) ?? []
    list.push(view)
    byObject.set(owner, list)
  }
  return objectRows().map((row) => {
    const code = textField(row, '对象编号')
    const points = byObject.get(code) ?? []
    const alarmPoints = points.filter((view) => view.derived.alarm)
    const measured = points
      .map((view) => view.derived.latestReading?.cumulative)
      .filter((value): value is number => typeof value === 'number')
    // 已布测点（有点位）即进入监测中；报警优先；一个测点都没有才是待布点。
    const notDeployed = points.length === 0
    return {
      row,
      pointCount: points.length,
      alarmCount: alarmPoints.length,
      maxCumulative: measured.length ? Math.max(...measured) : null,
      status: alarmPoints.length ? '已报警' : notDeployed ? '待布点' : '监测中',
      alarmPoints,
    }
  })
}

export function getMonitoringSummary(): MonitoringSummary {
  const { items } = listPointViews()
  const objects = listObjectViews()
  const latestDates = items.map((view) => view.derived.latestDate).filter(Boolean).sort()
  return {
    totalPoints: items.length,
    normalCount: items.filter((view) => view.derived.status === '正常').length,
    dueCount: items.filter((view) => view.derived.status === '待补测').length,
    fetchErrorCount: items.filter((view) => view.derived.status === '取数异常').length,
    alarmPointCount: items.filter((view) => view.derived.alarm).length,
    stableCount: items.filter((view) => view.derived.status === '已稳定').length,
    alarmObjectCount: objects.filter((view) => view.alarmCount > 0).length,
    objectCount: objects.length,
    latestDataDate: latestDates[latestDates.length - 1] ?? '',
    asOf: TODAY,
  }
}

// ---- 测区状态（整片取不回来时交代空态与原因） --------------------------------

export function listAreaStatuses(): AreaStatus[] {
  const aux = readMonitorAux()
  const { items } = listPointViews()
  const areas = [...new Set(items.map((view) => textField(view.row, '测区')).filter(Boolean))].sort()
  return areas.map((area) => {
    const own = items.filter((view) => textField(view.row, '测区') === area)
    const measuredToday = own.filter((view) => view.derived.latestDate === TODAY).length
    const latestDates = own.map((view) => view.derived.latestDate).filter(Boolean).sort()
    // 今天最新一条测区事件：整区未测 / 整区取数失败；
    // 但只要该区域今天已经取回任意一条读数，就不再是“整片取不到”，事件不再展示。
    const event = measuredToday === 0
      ? [...aux.areaEvents]
          .reverse()
          .find((item) => item.area === area && item.measureDate === TODAY)
      : undefined
    return {
      area,
      total: own.length,
      due: own.filter((view) => view.derived.due).length,
      measuredToday,
      latestDate: latestDates[latestDates.length - 1] ?? '',
      event,
    }
  })
}

// ---- 取数适配器（含演练场景注入） -------------------------------------------
// 真实项目这里接采集网关；纯前端用确定性的伪读数模拟，失败场景由演练开关注入。

export type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'not-measured'; reason: string }
  | { kind: 'fetch-failed'; reason: string }

export function getScenario(): ScenarioSpec {
  return readMonitorAux().scenario
}

export function setScenario(scenario: ScenarioSpec): void {
  const aux = readMonitorAux()
  writeMonitorAux({ ...aux, scenario })
}

function probeArea(aux: MonitorAux, area: string, dueCodes: string[]): ProbeResult {
  const scenario = aux.scenario
  if (scenario.kind === 'area-fetch-failed' && scenario.area === area && dueCodes.length > 0) {
    return { kind: 'fetch-failed', reason: `测区 ${area} 采集网关连接失败（HTTP 504 网关超时）` }
  }
  if (scenario.kind === 'area-not-measured' && scenario.area === area && dueCodes.length > 0) {
    return { kind: 'not-measured', reason: `测区 ${area} 今日未安排现场测量（监测班组未提交测回）` }
  }
  return { kind: 'ok' }
}

function nextSeq(aux: MonitorAux): number {
  aux.seq += 1
  return aux.seq
}

// 单次取数：按(测点+日期)确定性生成读数，同一测回的重试拿到的是同一个结果，
// 不会因为重试把读数“试”出另一个值。
function fetchOneReading(aux: MonitorAux, pointCode: string, measureDate: string): SettlementReading {
  const row = pointRows().find((item) => textField(item, '测点编号') === pointCode)
  if (!row) {
    throw new Error(`测点 ${pointCode} 不在台账中`)
  }
  const seed = hashText(`${pointCode}|${measureDate}`)
  if (aux.scenario.kind === 'point-failed' && aux.scenario.pointCode === pointCode) {
    throw new Error('现场采集终端无响应（无线电测链路中断）')
  }
  const previous = latestReading(aux, pointCode)
  // 增量 0.2~1.5mm，确定性，下沉取正；偶发回弹（极小概率）不在这里造。
  const increment = 0.2 + (seed % 14) / 10
  const cumulative = Number(((previous?.cumulative ?? 0) + increment).toFixed(1))
  const elevation = Number((numberField(row, '初始高程') - cumulative / 1000).toFixed(4))
  const intervalDays = previous ? Math.max(diffDays(previous.measureDate, measureDate), 1) : 1
  const rate = Number(((cumulative - (previous?.cumulative ?? 0)) / intervalDays).toFixed(1))
  return {
    id: nextSeq(aux),
    pointCode,
    measureDate,
    elevation,
    cumulative,
    rate,
    source: '自动取数',
    createdAt: new Date(`${TODAY}T09:00:00`).toISOString(),
  }
}

// ---- 读数落库：幂等 + 失败原样退回 ------------------------------------------

function applyReadingToPoint(row: EntryRow, reading: SettlementReading): EntryRow {
  const next: EntryRow = {
    ...row,
    当前高程: reading.elevation,
    累计沉降: reading.cumulative,
    沉降速率: reading.rate,
    最近监测: reading.measureDate,
  }
  return next
}

// 内部落库：先写读数明细，再写测点主表；主表写失败就回滚明细，把入参原样交回。
function persistReading(aux: MonitorAux, input: ReadingInput, source: ReadingInput['source']): SubmitReadingResult {
  const rows = pointRows()
  const index = rows.findIndex((row) => textField(row, '测点编号') === input.pointCode)
  if (index < 0) {
    return { ok: false, message: `测点 ${input.pointCode} 不在台账中`, returned: { ...input } }
  }
  const existing = findReading(aux, input.pointCode, input.measureDate)
  const duplicated = Boolean(existing)
  const initial = numberField(rows[index], '初始高程')
  const previous = [...aux.readings]
    .filter((item) => item.pointCode === input.pointCode && item.measureDate < input.measureDate)
    .sort((a, b) => (a.measureDate < b.measureDate ? 1 : -1))[0]
  const cumulative = Number(((initial - input.elevation) * 1000).toFixed(1))
  const intervalDays = previous ? Math.max(diffDays(previous.measureDate, input.measureDate), 1) : 1
  const rate = previous
    ? Number(((cumulative - previous.cumulative) / intervalDays).toFixed(1))
    : cumulative
  const reading: SettlementReading = {
    id: existing?.id ?? nextSeq(aux),
    pointCode: input.pointCode,
    measureDate: input.measureDate,
    elevation: input.elevation,
    cumulative,
    rate,
    source,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }

  const readings = duplicated
    ? aux.readings.map((item) => (item.id === reading.id ? reading : item))
    : [...aux.readings, reading]
  let nextAux: MonitorAux = {
    ...aux,
    readings,
    // 补测成功：该测点历史未闭环取数异常随这次补测闭环，不再顶在异常列表。
    failures: aux.failures.map((item) =>
      item.pointCode === input.pointCode && !item.resolved ? { ...item, resolved: true } : item,
    ),
  }

  const nextRows = [...rows]
  nextRows[index] = applyReadingToPoint(nextRows[index], reading)
  const auxSnapshot = aux
  try {
    writeMonitorAux(nextAux)
    try {
      saveRows(SETTLEMENT_KEY, nextRows)
    } catch (error) {
      // 主表存不进去：明细回滚，入参原样退回，绝不留半条。
      writeMonitorAux(auxSnapshot)
      throw error
    }
  } catch (error) {
    return {
      ok: false,
      message: `读数存不进去，已原样退回：${error instanceof Error ? error.message : '本地存储写入失败'}`,
      returned: { ...input },
    }
  }

  // 落库后再跑一遍越限判定，更新主表基础态（报警/正常）。
  syncAlarmFlags()
  return {
    ok: true,
    duplicated,
    message: duplicated
      ? `${input.pointCode} 在 ${input.measureDate} 已有监测，已按最新提交覆盖，全库仍只保留一条`
      : `${input.pointCode} ${input.measureDate} 监测已登记`,
    reading,
  }
}

// 根据最新读数/阈值，把报警标志回写到测点主表（基础态），派生页与主表不打架。
function syncAlarmFlags(): void {
  const aux = readMonitorAux()
  const objects = new Map(objectRows().map((item) => [textField(item, '对象编号'), item]))
  const rows = pointRows()
  let changed = false
  const next = rows.map((row) => {
    if (row.status === '已稳定') {
      if (row.abnormal) {
        changed = true
        return { ...row, abnormal: false }
      }
      return row
    }
    const derived = derivePoint(row, aux, objects)
    if (Boolean(row.abnormal) !== derived.alarm) {
      changed = true
      return { ...row, abnormal: derived.alarm, status: derived.alarm ? '报警' : '正常', pending: false }
    }
    if (derived.alarm && row.status !== '报警') {
      changed = true
      return { ...row, status: '报警' }
    }
    return row
  })
  if (changed) {
    saveRows(SETTLEMENT_KEY, next)
  }
}

export function submitReading(input: ReadingInput, actor: Actor): SubmitReadingResult {
  if (actor.role !== '监测负责人' && actor.role !== '值班员') {
    return { ok: false, message: '当前身份不允许提交监测读数', returned: { ...input } }
  }
  if (!input.pointCode || !input.measureDate || !Number.isFinite(input.elevation)) {
    return { ok: false, message: '测点、监测日期、高程都不能为空', returned: { ...input } }
  }
  const aux = readMonitorAux()
  return persistReading(aux, { ...input, source: input.source || '人工补测' }, input.source || '人工补测')
}

// ---- 权限：只有本项目监测负责人能改预警阈值与初始高程 -------------------------

function requireLead(actor: Actor): string | null {
  if (actor.role !== '监测负责人') {
    return `只有本项目监测负责人可以修改预警阈值与初始高程（当前：${actor.name} / ${actor.role}）`
  }
  return null
}

export function updateThresholds(
  pointCode: string,
  patch: { cumulative?: number; rate?: number },
  actor: Actor,
): SubmitReadingResult {
  const denied = requireLead(actor)
  if (denied) {
    return { ok: false, message: denied }
  }
  const rows = pointRows()
  const index = rows.findIndex((row) => textField(row, '测点编号') === pointCode)
  if (index < 0) {
    return { ok: false, message: `测点 ${pointCode} 不在台账中` }
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    ...(patch.cumulative !== undefined && Number.isFinite(patch.cumulative)
      ? { 预警阈值: patch.cumulative }
      : {}),
    ...(patch.rate !== undefined && Number.isFinite(patch.rate) ? { 速率限值: patch.rate } : {}),
  }
  try {
    saveRows(SETTLEMENT_KEY, next)
  } catch (error) {
    return { ok: false, message: `阈值存不进去，已原样退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
  syncAlarmFlags()
  return { ok: true, message: `${pointCode} 阈值已更新（操作人：${actor.name}）` }
}

export function updateInitialElevation(pointCode: string, elevation: number, actor: Actor): SubmitReadingResult {
  const denied = requireLead(actor)
  if (denied) {
    return { ok: false, message: denied }
  }
  if (!Number.isFinite(elevation) || elevation <= 0) {
    return { ok: false, message: '初始高程必须是大于 0 的有效数值' }
  }
  const rows = pointRows()
  const index = rows.findIndex((row) => textField(row, '测点编号') === pointCode)
  if (index < 0) {
    return { ok: false, message: `测点 ${pointCode} 不在台账中` }
  }
  const current = numberField(rows[index], '当前高程') || elevation
  const cumulative = Number(((elevation - current) * -1000).toFixed(1))
  const next = [...rows]
  next[index] = { ...rows[index], 初始高程: elevation, 累计沉降: Math.max(cumulative, 0) }
  try {
    saveRows(SETTLEMENT_KEY, next)
  } catch (error) {
    return { ok: false, message: `初始高程存不进去，已原样退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
  syncAlarmFlags()
  return { ok: true, message: `${pointCode} 初始高程已改为 ${elevation.toFixed(4)}m，并按当前高程重算累计沉降（操作人：${actor.name}）` }
}

// ---- 布点：新测点 / 存量测点按布点日期补进台账 -------------------------------

export type PointDraft = {
  code: string
  location: string
  owner: string
  area: string
  initialElevation: number
  cumulativeThreshold: number
  rateThreshold: number
  frequency: string
  deployDate: string
}

export function deployPoint(draft: PointDraft, actor: Actor): SubmitReadingResult {
  if (!draft.code.trim()) {
    return { ok: false, message: '测点编号不能为空' }
  }
  if (!draft.deployDate) {
    return { ok: false, message: '布点日期不能为空' }
  }
  if (!Number.isFinite(draft.initialElevation) || draft.initialElevation <= 0) {
    return { ok: false, message: '初始高程必须是大于 0 的有效数值' }
  }
  const rows = pointRows()
  if (rows.some((row) => textField(row, '测点编号') === draft.code.trim())) {
    return { ok: false, message: `测点编号 ${draft.code} 已在台账中，不能重复布点` }
  }
  const ownerDefault = objectRows().find((row) => textField(row, '对象编号') === draft.owner)
  const frequency = draft.frequency || (ownerDefault ? textField(ownerDefault, '默认监测频次') : '1次/天')
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id: nextId,
    status: '正常',
    pending: false,
    abnormal: false,
    测点编号: draft.code.trim(),
    测点位置: draft.location,
    所属对象: draft.owner,
    测区: draft.area,
    初始高程: draft.initialElevation,
    当前高程: draft.initialElevation,
    累计沉降: 0,
    沉降速率: 0,
    预警阈值: draft.cumulativeThreshold,
    速率限值: draft.rateThreshold || 3.0,
    监测频次: frequency,
    布点日期: draft.deployDate,
    最近监测: '',
  }
  try {
    saveRows(SETTLEMENT_KEY, [...rows, row])
  } catch (error) {
    return { ok: false, message: `布点存不进去，已原样退回：${error instanceof Error ? error.message : '写入失败'}` }
  }
  return {
    ok: true,
    message: `${draft.code} 已按布点日期 ${draft.deployDate} 补进台账，首测应测日 ${addDays(draft.deployDate, frequencyDays(frequency))}（操作人：${actor.name}）`,
  }
}

// ---- 稳定 / 恢复（已稳定测点不进排期） ---------------------------------------

export function setStable(pointCode: string, stable: boolean, actor: Actor): SubmitReadingResult {
  const rows = pointRows()
  const index = rows.findIndex((row) => textField(row, '测点编号') === pointCode)
  if (index < 0) {
    return { ok: false, message: `测点 ${pointCode} 不在台账中` }
  }
  const next = [...rows]
  next[index] = { ...rows[index], status: stable ? '已稳定' : '正常', abnormal: false }
  try {
    saveRows(SETTLEMENT_KEY, next)
  } catch (error) {
    return { ok: false, message: `状态存不进去：${error instanceof Error ? error.message : '写入失败'}` }
  }
  return { ok: true, message: `${pointCode} 已${stable ? '确认稳定，退出监测排期' : '恢复监测，重新进入排期'}（操作人：${actor.name}）` }
}

// ---- 批量取数/补测：整区探针、逐点重试、断点续走 -----------------------------

const FETCH_ATTEMPTS = 3 // 1 次取数 + 2 次重试
let stopRequested = false

export function requestStop(): void {
  stopRequested = true
}

export function activeCursor() {
  return [...readMonitorAux().cursors].reverse().find((cursor) => cursor.running || cursor.interrupted)
}

export function resumeDueFetch(
  actor: Actor,
  area: string | null,
  onProgress?: (progress: BatchProgress) => void,
): BatchProgress {
  stopRequested = false
  const aux0 = readMonitorAux()
  let cursor = activeCursor()
  if (!cursor) {
    const { items } = listPointViews()
    const due = items.filter(
      (view) =>
        view.derived.due &&
        view.derived.status !== '已稳定' &&
        (area === null || textField(view.row, '测区') === area),
    )
    const id = `batch-${Date.now()}`
    cursor = {
      id,
      measureDate: TODAY,
      area,
      total: due.length,
      done: [],
      success: 0,
      failed: 0,
      skipped: 0,
      running: true,
      interrupted: false,
      startedAt: new Date().toISOString(),
    }
    if (cursor.total === 0) {
      cursor.running = false
      cursor.finishedAt = new Date().toISOString()
      writeMonitorAux({ ...aux0, cursors: [...aux0.cursors, cursor] })
      return {
        cursorId: cursor.id,
        total: 0,
        done: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        currentCode: '',
        finished: true,
        interrupted: false,
        areaBlocks: [],
      }
    }
    writeMonitorAux({ ...aux0, cursors: [...aux0.cursors, cursor] })
  }

  // 重新算出还欠测的测点顺序；游标 done 里的（已成功/已确认跳过）绝不重测。
  const { items } = listPointViews()
  const dueOrder = items
    .filter(
      (view) =>
        view.derived.due &&
        view.derived.status !== '已稳定' &&
        (cursor!.area === null || textField(view.row, '测区') === cursor!.area),
    )
    .map((view) => textField(view.row, '测点编号'))
  const pending = dueOrder.filter((code) => !cursor!.done.includes(code))

  const areaBlocks: BatchProgress['areaBlocks'] = []
  // 每个测区先探一针：整片没测量 / 整片取不到时直接交代，不白白逐点重试。
  const pendingAreas = [...new Set(pending.map((code) => {
    const row = pointRows().find((item) => textField(item, '测点编号') === code)
    return row ? textField(row, '测区') : ''
  }))].filter(Boolean)

  const aux = readMonitorAux()
  const newAreaEvents: AreaEvent[] = []
  const blockedAreas = new Set<string>()
  for (const areaName of pendingAreas) {
    if (stopRequested) {
      break
    }
    const ownPending = pending.filter((code) => {
      const row = pointRows().find((item) => textField(item, '测点编号') === code)
      return row && textField(row, '测区') === areaName
    })
    const probe = probeArea(aux, areaName, ownPending)
    if (probe.kind !== 'ok') {
      blockedAreas.add(areaName)
      const already = aux.areaEvents.some(
        (event) => event.area === areaName && event.measureDate === TODAY,
      )
      areaBlocks.push({ area: areaName, kind: probe.kind, reason: probe.reason })
      if (!already) {
        newAreaEvents.push({
          id: nextSeq(aux),
          area: areaName,
          measureDate: TODAY,
          kind: probe.kind,
          reason: probe.reason,
          attempts: probe.kind === 'fetch-failed' ? FETCH_ATTEMPTS : 1,
          at: new Date().toISOString(),
        })
      }
    }
  }

  let success = cursor.success
  let failed = cursor.failed
  let skipped = cursor.skipped
  const done = [...cursor.done]
  let currentCode = cursor.lastPointCode ?? ''

  const pointFailures: FetchFailure[] = []
  for (const code of pending) {
    if (stopRequested) {
      break
    }
    currentCode = code
    const row = pointRows().find((item) => textField(item, '测点编号') === code)
    if (!row) {
      done.push(code)
      skipped += 1
      continue
    }
    const areaName = textField(row, '测区')
    if (blockedAreas.has(areaName)) {
      // 整区探针已定性，这些点本轮不再逐个尝试，保持上轮累计不动。
      done.push(code)
      skipped += 1
      continue
    }
    const auxNow = readMonitorAux()
    if (findReading(auxNow, code, TODAY)) {
      // 游标之外已经有人测过了：跳过而不是重测。
      done.push(code)
      skipped += 1
      continue
    }

    let lastError = ''
    let reading: SettlementReading | null = null
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      try {
        reading = fetchOneReading(auxNow, code, TODAY)
        lastError = ''
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : '取数失败'
      }
    }

    if (reading && !lastError) {
      const result = persistReading(auxNow, { pointCode: code, measureDate: TODAY, elevation: reading.elevation, source: '自动取数' }, '自动取数')
      if (result.ok) {
        success += 1
      } else {
        failed += 1
        pointFailures.push({
          id: nextSeq(auxNow),
          pointCode: code,
          area: areaName,
          measureDate: TODAY,
          reason: result.message,
          attempts: 1,
          at: new Date().toISOString(),
          resolved: false,
        })
      }
    } else {
      // 重试耗尽：记一条异常并写明原因；上一轮累计沉降/速率原样保留，绝不顶替。
      failed += 1
      pointFailures.push({
        id: nextSeq(auxNow),
        pointCode: code,
        area: areaName,
        measureDate: TODAY,
        reason: `自动取数重试 ${FETCH_ATTEMPTS} 次仍失败：${lastError}`,
        attempts: FETCH_ATTEMPTS,
        at: new Date().toISOString(),
        resolved: false,
      })
    }
    done.push(code)

    // 每个测点走完都把游标落盘：中断/刷新后能从断掉的那个测点接着走。
    const auxProgress = readMonitorAux()
    writeMonitorAux({
      ...auxProgress,
      areaEvents: [...auxProgress.areaEvents, ...newAreaEvents.splice(0)],
      failures: [...auxProgress.failures, ...pointFailures.splice(0)],
      cursors: auxProgress.cursors.map((item) =>
        item.id === cursor!.id
          ? { ...item, done: [...done], success, failed, skipped, lastPointCode: code }
          : item,
      ),
    })

    onProgress?.({
      cursorId: cursor.id,
      total: cursor.total,
      done: done.length,
      success,
      failed,
      skipped,
      currentCode: code,
      finished: false,
      interrupted: false,
      areaBlocks,
    })
  }

  // 收尾：登记剩余区级事件与点级异常，标记完成/中断。
  const auxEnd = readMonitorAux()
  const finishedAll = done.length >= cursor.total
  const nextCursor = {
    ...cursor,
    done,
    success,
    failed,
    skipped,
    running: false,
    interrupted: stopRequested && !finishedAll,
    lastPointCode: currentCode,
    finishedAt: finishedAll ? new Date().toISOString() : cursor.finishedAt,
  }
  writeMonitorAux({
    ...auxEnd,
    areaEvents: [...auxEnd.areaEvents, ...newAreaEvents],
    failures: [...auxEnd.failures, ...pointFailures],
    cursors: auxEnd.cursors.map((item) => (item.id === cursor!.id ? nextCursor : item)),
  })
  syncAlarmFlags()

  return {
    cursorId: cursor.id,
    total: cursor.total,
    done: done.length,
    success,
    failed,
    skipped,
    currentCode,
    finished: finishedAll,
    interrupted: nextCursor.interrupted,
    areaBlocks,
  }
}

// 单个测点立即取数（带 1 取 2 重试），失败记异常、不顶值。
export function fetchPointNow(pointCode: string, actor: Actor): SubmitReadingResult {
  const rows = pointRows()
  const row = rows.find((item) => textField(item, '测点编号') === pointCode)
  if (!row) {
    return { ok: false, message: `测点 ${pointCode} 不在台账中` }
  }
  const aux = readMonitorAux()
  if (findReading(aux, pointCode, TODAY)) {
    return { ok: true, duplicated: true, message: `${pointCode} 今日已测，不重复取数` }
  }
  let lastError = ''
  let reading: SettlementReading | null = null
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      reading = fetchOneReading(aux, pointCode, TODAY)
      break
    } catch (error) {
      lastError = error instanceof Error ? error.message : '取数失败'
    }
  }
  if (!reading || lastError) {
    const failure: FetchFailure = {
      id: nextSeq(aux),
      pointCode,
      area: textField(row, '测区'),
      measureDate: TODAY,
      reason: `自动取数重试 ${FETCH_ATTEMPTS} 次仍失败：${lastError}`,
      attempts: FETCH_ATTEMPTS,
      at: new Date().toISOString(),
      resolved: false,
    }
    try {
      writeMonitorAux({ ...aux, failures: [...aux.failures, failure] })
    } catch (error) {
      return { ok: false, message: `异常登记失败：${error instanceof Error ? error.message : '写入失败'}` }
    }
    return { ok: false, message: `${pointCode} 取数失败，已登记异常（不改动上轮累计沉降）：${lastError}` }
  }
  return persistReading(aux, { pointCode, measureDate: TODAY, elevation: reading.elevation, source: '自动取数' }, '自动取数')
}

// ---- 导出（沿用既有 CSV 方式，状态列用同源派生态） ---------------------------

export function exportSettlement(): { filename: string; content: string } {
  const meta = MODULE_BY_KEY.get(SETTLEMENT_KEY)!
  const { items } = listPointViews()
  const header = [...meta.fields, '当前状态', '报警依据', '未闭环取数异常']
  const lines = [header.join(',')]
  for (const { row, derived } of items) {
    lines.push(
      [
        ...meta.fields.map((field) => row[field] ?? ''),
        derived.status,
        derived.alarmReasons.join('；'),
        derived.openFailure ? derived.openFailure.reason : '',
      ]
        .map((cell) => String(cell).replace(/,/g, '，'))
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
