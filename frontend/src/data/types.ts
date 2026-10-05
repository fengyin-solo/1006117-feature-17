/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ===== 地表沉降监测域扩展 =====
// 测点主记录仍是 settlement 模块的 EntryRow（沿用既有读取方式）；
// 读数明细、取数异常、补测游标等放在独立的沉降扩展存储里。

export type MonitorRole = '监测负责人' | '值班员'

export type Actor = {
  name: string
  role: MonitorRole
}

export type ReadingSource = '自动取数' | '人工补测'

/** 一条监测读数：同一测点 + 同一监测日期全库唯一，重复提交只保留这一条。 */
export type SettlementReading = {
  id: number
  pointCode: string
  measureDate: string
  elevation: number
  cumulative: number
  rate: number
  source: ReadingSource
  createdAt: string
}

/** 取数异常：重试耗尽后记一条，原因写清楚，且不得顶替上一轮累计沉降。 */
export type FetchFailure = {
  id: number
  pointCode: string
  area: string
  measureDate: string
  reason: string
  attempts: number
  at: string
  resolved: boolean
}

/** 整片测区级事件：一个读数都取不回来时，用来交代是「没测量」还是「没取到」。 */
export type AreaEvent = {
  id: number
  area: string
  measureDate: string
  kind: 'not-measured' | 'fetch-failed'
  reason: string
  attempts: number
  at: string
}

/** 批量补测游标：中断后按 done 断点续走，已完成的测点不再重测。 */
export type BatchCursor = {
  id: string
  measureDate: string
  area: string | null
  total: number
  done: string[]
  success: number
  failed: number
  skipped: number
  running: boolean
  interrupted: boolean
  startedAt: string
  finishedAt?: string
  lastPointCode?: string
}

/** 取数演练场景：normal 之外用来复现「整区未测 / 整区取数失败 / 单点失败」。 */
export type ScenarioSpec =
  | { kind: 'normal' }
  | { kind: 'area-not-measured'; area: string }
  | { kind: 'area-fetch-failed'; area: string }
  | { kind: 'point-failed'; pointCode: string }

export type MonitorAux = {
  readings: SettlementReading[]
  failures: FetchFailure[]
  areaEvents: AreaEvent[]
  cursors: BatchCursor[]
  scenario: ScenarioSpec
  seq: number
}

export type PointDerived = {
  status: '正常' | '待补测' | '取数异常' | '报警' | '已稳定'
  due: boolean
  overdueDays: number
  alarm: boolean
  alarmReasons: string[]
  openFailure?: FetchFailure
  latestReading?: SettlementReading
  nextDueDate: string
  latestDate: string
}

export type PointView = {
  row: EntryRow
  derived: PointDerived
}

export type AreaStatus = {
  area: string
  total: number
  due: number
  measuredToday: number
  latestDate: string
  event?: AreaEvent
}

export type ObjectView = {
  row: EntryRow
  pointCount: number
  alarmCount: number
  maxCumulative: number | null
  status: '待布点' | '监测中' | '已报警'
  alarmPoints: PointView[]
}

export type MonitoringSummary = {
  totalPoints: number
  normalCount: number
  dueCount: number
  fetchErrorCount: number
  alarmPointCount: number
  stableCount: number
  alarmObjectCount: number
  objectCount: number
  latestDataDate: string
  asOf: string
}

export type ReadingInput = {
  pointCode: string
  measureDate: string
  elevation: number
  source: ReadingSource
}

export type BatchProgress = {
  cursorId: string
  total: number
  done: number
  success: number
  failed: number
  skipped: number
  currentCode: string
  finished: boolean
  interrupted: boolean
  areaBlocks: { area: string; kind: AreaEvent['kind']; reason: string }[]
}

export type SubmitReadingResult = {
  ok: boolean
  message: string
  duplicated?: boolean
  returned?: ReadingInput
  reading?: SettlementReading
}
