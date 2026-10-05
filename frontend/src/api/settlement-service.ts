/**
 * 地表沉降监测领域服务（纯前端本地实现）。
 *
 * 约定：所有业务判断都在这里做，页面只负责渲染；写库统一走 local-store。
 * 报警口径以沉降测点记录为唯一事实源，建筑监测页只读这份统计，不另算。
 */
import {
  listBatches,
  listReadings,
  listRows,
  resetSettlementStores,
  saveBatches,
  saveReadings,
  saveRows,
} from '@/data/local-store'
import { TODAY } from '@/data/settlement-seed'
import type {
  CollectBatchRow,
  CollectOutcome,
  CollectStatus,
  EntryRow,
  PointView,
  ReadingRow,
  ZoneStatus,
} from '@/data/types'

// ────────────────────────── 角色与权限 ──────────────────────────

const ROLE_KEY = 'shield-tunnel-construction:role'
export const ROLE_OWNER = '监测负责人'
export const ROLE_VIEWER = '值班管理员'

export function currentRole(): string {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage.getItem(ROLE_KEY) ?? ROLE_OWNER
  }
  return ROLE_OWNER
}

export function setCurrentRole(role: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ROLE_KEY, role)
  }
}

/** 预警阈值、速率报警阈值、初始高程只有本项目的监测负责人能改。 */
export function canEditBaseline(): boolean {
  return currentRole() === ROLE_OWNER
}

// ────────────────────────── 日期与频次排期 ──────────────────────────

function toDate(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

function addDays(value: string, days: number): string {
  const d = toDate(value)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function diffDays(a: string, b: string): number {
  return Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86_400_000)
}

/** 「1次/天」→1、「1次/2天」→2，解析不了按 1 天排。 */
export function frequencyDays(freq: string): number {
  const matched = /(\d+)\s*天/.exec(String(freq ?? ''))
  return matched ? Number(matched[1]) : 1
}

/** 由布点日期 + 频次推算每个应测日，取不晚于今天的最近一个。 */
export function dueDateOf(point: EntryRow, today = TODAY): string {
  const start = String(point['布点日期'] ?? '')
  if (!start) {
    return today
  }
  const span = frequencyDays(String(point['监测频次']))
  const elapsed = Math.max(0, diffDays(today, start))
  return addDays(start, Math.floor(elapsed / span) * span)
}

function points(): EntryRow[] {
  return listRows('settlement')
}

function buildings(): EntryRow[] {
  return listRows('building')
}

function findPoint(id: number): EntryRow | undefined {
  return points().find((row) => Number(row.id) === id)
}

// ────────────────────────── 读数查询与幂等 ──────────────────────────

export function readingsOf(pointId: number, date?: string): ReadingRow[] {
  return listReadings()
    .filter((row) => row.pointId === pointId && (date === undefined || row['监测日期'] === date))
    .sort((a, b) => (a['监测日期'] < b['监测日期'] ? 1 : -1))
}

/** 同测点同日只留一条：已存在就原地更新（再交一遍不会翻倍）。 */
function upsertReading(reading: ReadingRow): ReadingRow[] {
  const rows = listReadings()
  const index = rows.findIndex(
    (row) => row.pointId === reading.pointId && row['监测日期'] === reading['监测日期'],
  )
  if (index >= 0) {
    const next = [...rows]
    next[index] = { ...reading, id: rows[index].id }
    saveReadings(next)
    return next
  }
  const nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  const next = [...rows, { ...reading, id: nextId }]
  saveReadings(next)
  return next
}

// ────────────────────────── 测点派生视图 ──────────────────────────

export function latestSuccessReading(pointId: number): ReadingRow | undefined {
  return listReadings()
    .filter((row) => row.pointId === pointId && row['采集状态'] === '已采集')
    .sort((a, b) => (a['监测日期'] < b['监测日期'] ? 1 : -1))[0]
}

function readingToday(pointId: number, date: string): ReadingRow | undefined {
  return listReadings().find((row) => row.pointId === pointId && row['监测日期'] === date)
}

function collectStatusOf(point: EntryRow, date = TODAY): CollectStatus {
  if (point.status === '已稳定') {
    return '已稳定停测'
  }
  const today = readingToday(Number(point.id), date)
  if (today) {
    return today['采集状态'] === '已采集' ? '已采集' : '取数异常'
  }
  return dueDateOf(point, date) <= date ? '待补测' : '待补测'
}

export function listPointViews(date = TODAY): PointView[] {
  return points().map((point) => {
    const status = collectStatusOf(point, date)
    const today = readingToday(Number(point.id), date)
    const due = dueDateOf(point, date)
    return {
      ...point,
      采集状态: status,
      应测日期: due,
      异常原因: today?.['异常原因'] ?? '',
      今日累计沉降: today && today['采集状态'] === '已采集' ? String(today['累计沉降']) : '',
      今日沉降速率: today && today['采集状态'] === '已采集' ? String(today['沉降速率']) : '',
      报警对象编号: String(point['关联建筑编号'] ?? ''),
      报警对象名称: String(point['关联建筑名称'] ?? ''),
    }
  })
}

/**
 * 到期（含逾期）仍没有成功读数的测点，进入取数/补测队列。
 * 今天已记「取数异常」的测点同样留在队列里，等重试；调用方按采集状态区分「待补测/异常」。
 */
export function listDuePoints(date = TODAY): EntryRow[] {
  return points()
    .filter((point) => point.status !== '已稳定')
    .filter((point) => dueDateOf(point, date) <= date)
    .filter((point) => {
      const today = readingToday(Number(point.id), date)
      return !today || today['采集状态'] !== '已采集'
    })
    .sort((a, b) => {
      const da = dueDateOf(a, date)
      const db = dueDateOf(b, date)
      if (da !== db) {
        return da < db ? -1 : 1
      }
      return String(a['测点编号']) < String(b['测点编号']) ? -1 : 1
    })
}

// ────────────────────────── 取数网关（本地模拟，可整体替换为真实接口） ──────────────────────────

const FAIL_REASONS = [
  '监测设备无响应',
  '数据传输超时',
  '采集仪电量耗尽',
  '信号链路中断',
]

type GatewayReply = { ok: true; elevation: number } | { ok: false; reason: string }

/**
 * 脚本化网关：把演示场景钉死，便于验收。
 * - A 区：第 1 次取数先失败、重试第 2 次成功（验证「重试而不是顶上一轮」）；
 * - C 区：连续 3 次全部失败（验证整区「未取到」与异常记账）；
 * - 其余：确定性温和沉降，正常落数。
 */
const SCRIPTED: Record<string, { failAttempts: number; elevation: number; reason: string }> = {
  'SETT-0001': { failAttempts: 1, elevation: 5.1285, reason: FAIL_REASONS[1] },
  'SETT-0002': { failAttempts: 1, elevation: 5.0807, reason: FAIL_REASONS[3] },
  'SETT-0003': { failAttempts: 1, elevation: 5.1784, reason: FAIL_REASONS[0] }, // 今日累计-21.6、速率-3.0，仍越速率线
  'SETT-0007': { failAttempts: 3, elevation: 6.031, reason: FAIL_REASONS[0] },
  'SETT-0008': { failAttempts: 3, elevation: 6.0085, reason: FAIL_REASONS[0] },
  'SETT-0009': { failAttempts: 3, elevation: 6.0472, reason: FAIL_REASONS[0] },
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchElevation(point: EntryRow, attempt: number): Promise<GatewayReply> {
  await wait(180)
  const code = String(point['测点编号'])
  const script = SCRIPTED[code]
  if (script) {
    if (attempt <= script.failAttempts) {
      return { ok: false, reason: script.reason }
    }
    return { ok: true, elevation: script.elevation }
  }
  // 非脚本测点：由初始高程 + 温和沉降量推出本次高程，保证数值自洽。
  const base = Number(point['初始高程'])
  const last = latestSuccessReading(Number(point.id))
  const prevElevation = last ? last['本次高程'] : base
  const span = frequencyDays(String(point['监测频次']))
  const step = Number(point.id) % 2 === 0 ? -0.0009 * span : -0.0006 * span
  return { ok: true, elevation: round3(prevElevation + step) }
}

// ────────────────────────── 越限判定与报警同步 ──────────────────────────

export type AlarmConclusion = '正常' | '预警' | '报警'

/** 报警结论写回测点主数据；已稳定测点不参与报警。 */
export function judgeAlarm(point: EntryRow, cumulative: number, rate: number): {
  conclusion: AlarmConclusion
  reasons: string[]
} {
  const limit = Number(point['预警阈值']) || 0 // 沉降阈值为负值
  const rateLimit = Number(point['速率报警阈值']) || 0
  const reasons: string[] = []
  let alarm = false
  let warn = false
  if (cumulative <= limit) {
    alarm = true
    reasons.push(`累计沉降 ${cumulative}mm 达到/超过报警阈值 ${limit}mm`)
  }
  if (rate <= rateLimit) {
    alarm = true
    reasons.push(`沉降速率 ${rate}mm/d 达到/超过速率报警阈值 ${rateLimit}mm/d`)
  }
  if (!alarm && cumulative <= limit * 0.8) {
    warn = true
    reasons.push(`累计沉降 ${cumulative}mm 达到预警线（报警阈值的80%）`)
  }
  if (alarm) {
    return { conclusion: '报警', reasons }
  }
  if (warn) {
    return { conclusion: '预警', reasons }
  }
  return { conclusion: '正常', reasons: [] }
}

/** 把报警结论写回测点主数据；报警测点数两个页面都从这里派生，同属一份。 */
function applyConclusion(
  point: EntryRow,
  conclusion: AlarmConclusion | '已稳定',
  note: string,
): EntryRow {
  const next = [...points()]
  const index = next.findIndex((row) => Number(row.id) === Number(point.id))
  if (index < 0) {
    return point
  }
  const updated: EntryRow = {
    ...next[index],
    status: conclusion,
    abnormal: conclusion === '报警',
    // 待处理口径：预警要继续盯，报警走异常流程；正常取完即清零，已稳定停测。
    pending: conclusion === '预警' || conclusion === '报警',
    测点状态: note || String(next[index]['测点状态'] ?? ''),
  }
  next[index] = updated
  saveRows('settlement', next)
  return updated
}

/** 报警结论落到建筑监测对象清单：只把「监测中」的对象推进报警，已人工解除的不再自动翻案。 */
function syncBuildings(): void {
  const views = listPointViews()
  const grouped = new Map<string, PointView[]>()
  for (const view of views) {
    const code = view['报警对象编号']
    if (!code) {
      continue
    }
    grouped.set(code, [...(grouped.get(code) ?? []), view])
  }
  const rows = buildings()
  let changed = false
  const next = rows.map((row) => {
    const code = String(row['对象编号'])
    const linked = grouped.get(code) ?? []
    const alarming = linked.filter((view) => view.status === '报警')
    const maxSettlement = linked.reduce(
      (max, view) => Math.min(max, Number(view['累计沉降']) || 0),
      0,
    )
    if (row.status === '已解除' || row.status === '待布点') {
      return row
    }
    if (alarming.length > 0 && row.status !== '已报警') {
      changed = true
      return {
        ...row,
        status: '已报警',
        abnormal: true,
        实测沉降: maxSettlement,
        监测状态: `${alarming.length} 个关联测点越限，自动报警`,
      }
    }
    if (alarming.length === 0 && row.status === '已报警') {
      changed = true
      return {
        ...row,
        status: '监测中',
        abnormal: false,
        实测沉降: maxSettlement,
        监测状态: '关联测点恢复限值以内，报警自动解除',
      }
    }
    const measured = row['实测沉降']
    if (String(measured) !== String(maxSettlement)) {
      changed = true
      return { ...row, 实测沉降: maxSettlement }
    }
    return row
  })
  if (changed) {
    saveRows('building', next)
  }
}

// ────────────────────────── 取数落库（重试 + 异常记账 + 报警联动） ──────────────────────────

const MAX_ATTEMPTS = 3

type PersistArgs = {
  point: EntryRow
  date: string
  elevation: number
  source: ReadingRow['来源']
  operator: string
}

function persistSuccess(args: PersistArgs): ReadingRow {
  const { point, date, elevation, source, operator } = args
  const base = Number(point['初始高程'])
  const prev = readingsOf(Number(point.id))
    .filter((row) => row['监测日期'] < date && row['采集状态'] === '已采集')
    .sort((a, b) => (a['监测日期'] < b['监测日期'] ? 1 : -1))[0]
  const cumulative = round2((elevation - base) * 1000)
  const interval = prev ? Math.max(1, diffDays(date, prev['监测日期'])) : 1
  const rate = prev ? round2((cumulative - Number(prev['累计沉降'])) / interval) : cumulative
  const reading: ReadingRow = {
    id: 0,
    pointId: Number(point.id),
    测点编号: String(point['测点编号']),
    测区: String(point['测区'] ?? ''),
    监测日期: date,
    本次高程: elevation,
    本次沉降: prev ? round2(cumulative - Number(prev['累计沉降'])) : cumulative,
    累计沉降: cumulative,
    沉降速率: rate,
    来源: source,
    采集状态: '已采集',
    异常原因: '',
    提交人: operator,
  }
  upsertReading(reading)
  const judged = judgeAlarm(point, cumulative, rate)
  const note =
    judged.conclusion === '报警'
      ? judged.reasons.join('；')
      : judged.conclusion === '预警'
        ? judged.reasons.join('；')
        : `${date} 读数正常`
  applyConclusion(
    { ...point, 累计沉降: cumulative, 沉降速率: rate },
    point.status === '已稳定' ? '已稳定' : judged.conclusion,
    note,
  )
  // 主台账的累计沉降/速率同步刷新成最新成功读数（取数失败时不会走到这里，旧值不会被顶）。
  const rows = points()
  const index = rows.findIndex((row) => Number(row.id) === Number(point.id))
  if (index >= 0) {
    const next = [...rows]
    // 正常取数成功：本期待处理清零；预警/报警由 applyConclusion 按结论置位。
    next[index] = {
      ...next[index],
      累计沉降: cumulative,
      沉降速率: rate,
      pending: judged.conclusion === '预警' || judged.conclusion === '报警',
    }
    saveRows('settlement', next)
  }
  syncBuildings()
  return listReadings().find(
    (row) => row.pointId === Number(point.id) && row['监测日期'] === date,
  ) as ReadingRow
}

function persistFailure(point: EntryRow, date: string, reason: string, operator: string): ReadingRow {
  const reading: ReadingRow = {
    id: 0,
    pointId: Number(point.id),
    测点编号: String(point['测点编号']),
    测区: String(point['测区'] ?? ''),
    监测日期: date,
    本次高程: 0,
    本次沉降: 0,
    累计沉降: 0,
    沉降速率: 0,
    来源: '网关取数',
    采集状态: '取数异常',
    异常原因: `重试${MAX_ATTEMPTS}次仍失败：${reason}`,
    提交人: operator,
  }
  upsertReading(reading)
  // 异常只落在读数上并标 pending/abnormal，主台账累计沉降保持上一轮成功值，绝不顶上一轮冒充新数。
  const rows = points()
  const index = rows.findIndex((row) => Number(row.id) === Number(point.id))
  if (index >= 0) {
    const next = [...rows]
    next[index] = { ...next[index], pending: true, abnormal: true }
    saveRows('settlement', next)
  }
  return listReadings().find(
    (row) => row.pointId === Number(point.id) && row['监测日期'] === date,
  ) as ReadingRow
}

/**
 * 单点取数：最多重试 3 次。
 * 中途失败不落任何读数，累计沉降保持上一轮；3 次仍败才按异常记一条并写明原因。
 */
export async function collectPoint(
  pointId: number,
  date = TODAY,
  operator = currentRole(),
): Promise<CollectOutcome> {
  const point = findPoint(pointId)
  if (!point) {
    return { ok: false, pointId, attempts: 0, message: '没有找到该沉降测点' }
  }
  if (point.status === '已稳定') {
    return { ok: false, pointId, attempts: 0, message: '测点已确认稳定，不再取数' }
  }
  const existing = readingToday(pointId, date)
  if (existing && existing['采集状态'] === '已采集') {
    return {
      ok: true,
      pointId,
      attempts: 0,
      reading: existing,
      message: `${date} 已测过，沿用既有读数，不重复取数`,
    }
  }
  // 此前已记最终异常的测点：再试时从第 1 次重新计数（新一轮重试）。
  let lastReason = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const reply = await fetchElevation(point, attempt)
    if (reply.ok) {
      const reading = persistSuccess({
        point,
        date,
        elevation: reply.elevation,
        source: '网关取数',
        operator,
      })
      return {
        ok: true,
        pointId,
        attempts: attempt,
        reading,
        message: attempt === 1 ? '取数成功' : `第 ${attempt} 次重试取数成功`,
      }
    }
    lastReason = reply.reason
  }
  const reading = persistFailure(point, date, lastReason, operator)
  return {
    ok: false,
    pointId,
    attempts: MAX_ATTEMPTS,
    reading,
    reason: reading['异常原因'],
    message: reading['异常原因'],
  }
}

/**
 * 整片测区取数：每个测点当轮只试一次。
 * 一条都取不回来时当场按异常记账（写明原因），页面据此交代「没取到」而不是停在加载；
 * 单测点的 3 次重试由 collectPoint（测点行「重试取数」/补测批次）承担。
 */
export async function collectZoneOnce(
  zone: string,
  date = TODAY,
  operator = currentRole(),
): Promise<{ results: CollectOutcome[]; zoneStatus: ZoneStatus }> {
  const targets = listDuePoints(date).filter(
    (point) => String(point['测区'] ?? '') === zone,
  )
  const results: CollectOutcome[] = []
  for (const point of targets) {
    const reply = await fetchElevation(point, 1)
    if (reply.ok) {
      const reading = persistSuccess({
        point,
        date,
        elevation: reply.elevation,
        source: '网关取数',
        operator,
      })
      results.push({ ok: true, pointId: Number(point.id), attempts: 1, reading, message: '取数成功' })
    } else {
      // 整区口径：本轮取不回来即记最终异常，空态能明确说「没取到」；后续可在测点行重试覆盖。
      const reading = persistFailure(point, date, reply.reason, operator)
      results.push({
        ok: false,
        pointId: Number(point.id),
        attempts: 1,
        reading,
        reason: reading['异常原因'],
        message: reading['异常原因'],
      })
    }
  }
  return { results, zoneStatus: zoneStatusOf(zone, date) }
}

// ────────────────────────── 人工补录（同日幂等，校验不过原样退回） ──────────────────────────

export type ManualReadingInput = {
  pointId: number
  date: string
  elevationText: string
}

export type ManualResult = {
  ok: boolean
  message: string
  returned?: ManualReadingInput
  reading?: ReadingRow
}

export function submitManualReading(
  input: ManualReadingInput,
  operator = currentRole(),
): ManualResult {
  const reject = (message: string): ManualResult => ({
    ok: false,
    message,
    returned: { ...input }, // 存不进去原样退回，表单回填用
  })
  const point = findPoint(input.pointId)
  if (!point) {
    return reject('没有找到该沉降测点')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return reject('监测日期格式应为 YYYY-MM-DD')
  }
  const elevation = Number(input.elevationText)
  if (!Number.isFinite(elevation) || input.elevationText.trim() === '') {
    return reject('本次高程必须是数字，原样退回请核对后重交')
  }
  const base = Number(point['初始高程'])
  if (Math.abs(elevation - base) > 0.5) {
    return reject(`本次高程 ${elevation} 与初始高程偏差超过 0.5m，疑似录错，原样退回`)
  }
  try {
    const reading = persistSuccess({
      point,
      date: input.date,
      elevation,
      source: '人工补录',
      operator,
    })
    return { ok: true, message: '监测读数已提交（同测点同日只保留一条）', reading }
  } catch (error) {
    return reject(
      `读数写入本地存储失败：${error instanceof Error ? error.message : '未知错误'}，数据原样退回`,
    )
  }
}

// ────────────────────────── 测点登记与基线修改 ──────────────────────────

export type PointRegisterInput = {
  code: string
  location: string
  zone: string
  baseElevationText: string
  thresholdText: string
  rateThresholdText: string
  frequency: string
  deployDate: string
  buildingCode: string
  buildingName: string
}

export function registerPoint(
  input: PointRegisterInput,
  operator = currentRole(),
): { ok: boolean; message: string; returned?: PointRegisterInput } {
  const reject = (message: string) => ({ ok: false, message, returned: { ...input } })
  if (!input.code.trim()) {
    return reject('测点编号不能为空')
  }
  if (!input.deployDate) {
    return reject('布点日期必填，存量测点也按布点日期补进台账')
  }
  if (points().some((row) => String(row['测点编号']) === input.code.trim())) {
    return reject(`测点编号 ${input.code} 已存在，不能重复登记`)
  }
  const base = Number(input.baseElevationText)
  const threshold = Number(input.thresholdText)
  const rateThreshold = Number(input.rateThresholdText)
  if (!Number.isFinite(base) || !Number.isFinite(threshold) || !Number.isFinite(rateThreshold)) {
    return reject('初始高程、预警阈值、速率报警阈值都必须是数字，原样退回')
  }
  if (threshold >= 0 || rateThreshold >= 0) {
    return reject('沉降类阈值应为负数（表示下沉限值），原样退回')
  }
  const rows = points()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const firstDue = (() => {
    const span = frequencyDays(input.frequency || '1次/天')
    const elapsed = Math.max(0, diffDays(TODAY, input.deployDate))
    return addDays(input.deployDate, Math.floor(elapsed / span) * span)
  })()
  const row: EntryRow = {
    id,
    status: '正常',
    pending: firstDue <= TODAY,
    abnormal: false,
    测点编号: input.code.trim(),
    测点位置: input.location.trim(),
    测区: input.zone.trim() || '未分区',
    初始高程: base,
    累计沉降: 0,
    沉降速率: 0,
    预警阈值: threshold,
    速率报警阈值: rateThreshold,
    监测频次: input.frequency || '1次/天',
    布点日期: input.deployDate,
    关联建筑编号: input.buildingCode.trim(),
    关联建筑名称: input.buildingName.trim(),
    测点状态: '已布点待首测',
  }
  try {
    saveRows('settlement', [...rows, row])
    return { ok: true, message: `测点 ${input.code} 已按布点日期 ${input.deployDate} 登记进台账（操作人：${operator}）` }
  } catch (error) {
    return reject(`写入本地存储失败：${error instanceof Error ? error.message : '未知错误'}，原样退回`)
  }
}

export function updateBaseline(
  pointId: number,
  patch: { 初始高程?: number; 预警阈值?: number; 速率报警阈值?: number },
  operator = currentRole(),
): { ok: boolean; message: string } {
  if (!canEditBaseline()) {
    return { ok: false, message: '只有本项目的监测负责人能修改预警阈值与初始高程' }
  }
  const rows = points()
  const index = rows.findIndex((row) => Number(row.id) === pointId)
  if (index < 0) {
    return { ok: false, message: '没有找到该沉降测点' }
  }
  if (
    (patch['预警阈值'] !== undefined && patch['预警阈值'] >= 0) ||
    (patch['速率报警阈值'] !== undefined && patch['速率报警阈值'] >= 0)
  ) {
    return { ok: false, message: '沉降类阈值应为负数' }
  }
  const next = [...rows]
  next[index] = { ...next[index], ...patch, 测点状态: `基线由${operator}于${TODAY}修订` }
  saveRows('settlement', next)
  // 阈值变了，报警结论要按既有读数重新落一遍。
  const latest = latestSuccessReading(pointId)
  if (latest) {
    const judged = judgeAlarm(next[index], latest['累计沉降'], latest['沉降速率'])
    applyConclusion(next[index], judged.conclusion, judged.reasons.join('；') || '阈值修订后读数正常')
  }
  syncBuildings()
  return { ok: true, message: '基线参数已由监测负责人修订' }
}

// ────────────────────────── 补测批次（断点续跑） ──────────────────────────

export function listBatchesView(): CollectBatchRow[] {
  return [...listBatches()].sort((a, b) => (a['更新时间'] < b['更新时间'] ? 1 : -1))
}

export function resumeableBatch(date = TODAY): CollectBatchRow | undefined {
  return listBatches().find(
    (batch) => batch['监测日期'] === date && batch['状态'] === '进行中',
  )
}

/** 建批次时只把「今天还没成功」的测点排进去；顺序：到期日早的先、同日测点编号小的先。 */
export function startBatch(
  scope: string,
  date = TODAY,
  operator = currentRole(),
): { ok: boolean; message: string; batch?: CollectBatchRow } {
  if (resumeableBatch(date)) {
    return { ok: false, message: '今天已有进行中的补测批次，请从断点继续，不要重开' }
  }
  const targets = listDuePoints(date).filter(
    (point) => scope === 'ALL' || String(point['测区'] ?? '') === scope,
  )
  if (targets.length === 0) {
    return { ok: false, message: '该范围内没有到期待补测测点' }
  }
  const rows = listBatches()
  const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  const batch: CollectBatchRow = {
    id,
    scope,
    监测日期: date,
    状态: '进行中',
    计划测点: targets.map((row) => Number(row.id)),
    完成测点: [],
    成功测点: [],
    异常测点: [],
    更新时间: `${date} 由${operator}创建`,
  }
  saveBatches([...rows, batch])
  return { ok: true, message: `补测批次已建立，共 ${targets.length} 个测点，从最早到期的开始`, batch }
}

function saveBatch(batch: CollectBatchRow, note: string): void {
  const rows = listBatches()
  const index = rows.findIndex((row) => row.id === batch.id)
  const updated: CollectBatchRow = { ...batch, 更新时间: note }
  if (index >= 0) {
    const next = [...rows]
    next[index] = updated
    saveBatches(next)
  } else {
    saveBatches([...rows, updated])
  }
}

/** 推进一个测点；已经在完成清单里的直接跳过，保证中断后接着走、测完的不重测。 */
export async function advanceBatch(
  batchId: number,
  date = TODAY,
  operator = currentRole(),
): Promise<{ ok: boolean; message: string; batch?: CollectBatchRow; outcome?: CollectOutcome; done: boolean }> {
  const batch = listBatches().find((row) => row.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到该补测批次', done: false }
  }
  if (batch['状态'] !== '进行中') {
    return { ok: false, message: '批次已结束，不能再推进', done: true, batch }
  }
  const nextId = batch['计划测点'].find((id) => !batch['完成测点'].includes(id))
  if (nextId === undefined) {
    const finished: CollectBatchRow = { ...batch, 状态: '已完成' }
    saveBatch(finished, `${date} 全部测点处理完毕`)
    return { ok: true, message: '本批次已全部处理完', done: true, batch: finished }
  }
  const outcome = await collectPoint(nextId, date, operator)
  const done = [...batch['完成测点'], nextId]
  const success = outcome.ok ? [...batch['成功测点'], nextId] : batch['成功测点']
  const failed = outcome.ok ? batch['异常测点'] : [...batch['异常测点'], nextId]
  const updated: CollectBatchRow = {
    ...batch,
    完成测点: done,
    成功测点: success,
    异常测点: failed,
    状态: done.length === batch['计划测点'].length ? '已完成' : '进行中',
  }
  saveBatch(
    updated,
    `${date} 已处理 ${done.length}/${batch['计划测点'].length}，下一点：${
      updated['状态'] === '进行中'
        ? findPoint(updated['计划测点'][done.length])?.['测点编号'] ?? '—'
        : '无'
    }`,
  )
  return {
    ok: outcome.ok,
    message: outcome.message,
    done: updated['状态'] === '已完成',
    batch: updated,
    outcome,
  }
}

/** 一键续跑：从断掉的那个测点一路走到完，中间任何一步失败都记账后继续，不影响已测点。 */
export async function runBatchToEnd(
  batchId: number,
  date = TODAY,
  operator = currentRole(),
  onStep?: (state: CollectBatchRow, outcome: CollectOutcome) => void,
): Promise<CollectBatchRow> {
  let state = listBatches().find((row) => row.id === batchId)
  if (!state) {
    throw new Error('没有找到该补测批次')
  }
  // 防重入：游标以「完成测点」清单为准，再交一遍已测点会被 collectPoint 幂等跳过。
  while (state && state['状态'] === '进行中') {
    const result = await advanceBatch(batchId, date, operator)
    state = result.batch
    if (result.outcome && onStep && state) {
      onStep(state, result.outcome)
    }
    if (result.done) {
      break
    }
  }
  return state as CollectBatchRow
}

export function interruptBatch(batchId: number, note = '人工中断，可从断点续测'): { ok: boolean; message: string } {
  const rows = listBatches()
  const index = rows.findIndex((row) => row.id === batchId)
  if (index < 0) {
    return { ok: false, message: '没有找到该补测批次' }
  }
  const next = [...rows]
  next[index] = { ...next[index], 状态: '已中断' }
  saveBatches(next)
  return { ok: true, message: note }
}

/** 中断后续跑：只把状态拉回「进行中」，完成清单（游标）原样保留，从断掉的测点接着走。 */
export function resumeBatch(batchId: number): { ok: boolean; message: string; batch?: CollectBatchRow } {
  const rows = listBatches()
  const index = rows.findIndex((row) => row.id === batchId)
  if (index < 0) {
    return { ok: false, message: '没有找到该补测批次' }
  }
  if (rows[index]['状态'] !== '已中断') {
    return { ok: false, message: '只有已中断的批次才能续跑', batch: rows[index] }
  }
  if (resumeableBatch(rows[index]['监测日期'])) {
    return { ok: false, message: '今天已有另一个进行中的批次，请先处理它' }
  }
  const next = [...rows]
  next[index] = { ...next[index], 状态: '进行中' }
  saveBatch(next[index], `从中断点续跑，已完成 ${next[index]['完成测点'].length}/${next[index]['计划测点'].length}`)
  return { ok: true, message: '已从断点恢复，已测完的测点不会重测', batch: next[index] }
}

// ────────────────────────── 测区空态与统一统计 ──────────────────────────

export function listZones(): string[] {
  return [...new Set(points().map((row) => String(row['测区'] ?? '未分区')))].sort()
}

export function zoneStatusOf(zone: string, date = TODAY): ZoneStatus {
  const zonePoints = points().filter((row) => String(row['测区'] ?? '') === zone && row.status !== '已稳定')
  if (zonePoints.length === 0) {
    return { zone, state: '无测点', total: 0, collected: 0, pending: 0, failed: 0, reason: '该测区还没有布设测点' }
  }
  const due = zonePoints.filter((point) => dueDateOf(point, date) <= date)
  let collected = 0
  let failed = 0
  for (const point of due) {
    const today = readingToday(Number(point.id), date)
    if (today?.['采集状态'] === '已采集') {
      collected += 1
    } else if (today?.['采集状态'] === '取数异常') {
      failed += 1
    }
  }
  const pending = due.length - collected - failed
  let state: ZoneStatus['state']
  let reason: string
  if (collected === due.length) {
    state = '已采齐'
    reason = `${date} 应测 ${due.length} 个测点，已全部取到读数`
  } else if (collected === 0 && failed === 0) {
    // 一条都没回来：到底测没测？这里没有任何尝试记录，判为没测量。
    state = '未测量'
    reason = `${date} 该测区 ${due.length} 个测点均未开展测量（不是取数失败），已全部进入待补测`
  } else if (collected === 0 && failed > 0) {
    state = '未取到'
    reason = `${date} 该测区 ${failed} 个测点全部发起取数但一条都没取回来，重试仍败已按异常记账`
  } else {
    state = '部分异常'
    reason = `已取回 ${collected} 个，${failed} 个取数异常，${pending} 个尚未测量`
  }
  return { zone, state, total: due.length, collected, pending, failed, reason }
}

export type SettlementStats = {
  total: number
  alarmPoints: number
  warnPoints: number
  duePoints: number
  failedPoints: number
  alarmByBuilding: { code: string; name: string; alarm: number; total: number }[]
}

/** 唯一报警口径：两个页面都调它，读到的报警测点数必然一致。 */
export function settlementStats(date = TODAY): SettlementStats {
  const views = listPointViews(date)
  const todayFailed = views.filter((view) => view['采集状态'] === '取数异常').length
  const due = listDuePoints(date).filter((point) => {
    const today = readingToday(Number(point.id), date)
    return !today || today['采集状态'] !== '取数异常'
  }).length
  const map = new Map<string, { code: string; name: string; alarm: number; total: number }>()
  for (const view of views) {
    const code = view['报警对象编号']
    if (!code) {
      continue
    }
    const entry = map.get(code) ?? { code, name: view['报警对象名称'], alarm: 0, total: 0 }
    entry.total += 1
    if (view.status === '报警') {
      entry.alarm += 1
    }
    map.set(code, entry)
  }
  return {
    total: views.length,
    alarmPoints: views.filter((view) => view.status === '报警').length,
    warnPoints: views.filter((view) => view.status === '预警').length,
    duePoints: due,
    failedPoints: todayFailed,
    alarmByBuilding: [...map.values()].sort((a, b) => a.code.localeCompare(b.code)),
  }
}

export function resetSettlement(): void {
  resetSettlementStores()
}

/** 读数明细读取：读数台账页与导出共用这一条路径，避免各处各读各的。 */
export function listAllReadings(): ReadingRow[] {
  return [...listReadings()].sort((a, b) =>
    a['监测日期'] < b['监测日期'] ? 1 : a['监测日期'] > b['监测日期'] ? -1 : a.id - b.id,
  )
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 测点 + 当日读数合并导出，报警/异常状态直接带在同一行。 */
export function exportSettlementCsv(): { filename: string; content: string } {
  const header = [
    '测点编号', '测区', '测点位置', '初始高程', '累计沉降', '沉降速率',
    '累计报警阈值', '速率报警阈值', '监测频次', '布点日期', '应测日期',
    '关联建筑编号', '关联建筑名称', '监测结论', '采集状态', '异常原因',
  ]
  const lines = [header.join(',')]
  for (const view of listPointViews()) {
    lines.push([
      view.测点编号, view.测区, view.测点位置, view.初始高程, view.累计沉降, view.沉降速率,
      view.预警阈值, view.速率报警阈值, view.监测频次, view.布点日期, view.应测日期,
      view.报警对象编号, view.报警对象名称, view.status, view.采集状态, view.异常原因,
    ].map(csvEscape).join(','))
  }
  return { filename: '地表沉降-测点台账.csv', content: `﻿${lines.join('\n')}` }
}
