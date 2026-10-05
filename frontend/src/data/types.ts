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

// ────────────────────────── 地表沉降监测 ──────────────────────────

/** 采集状态：与监测结论（正常/预警/报警/已稳定）正交，专门交代「这轮读数取没取到」。 */
export type CollectStatus = '已采集' | '待补测' | '取数异常' | '已稳定停测'

/** 监测读数：同一测点同一监测日期只允许一条，重复提交按 upsert 处理（再交一遍不翻倍）。 */
export type ReadingRow = {
  id: number
  pointId: number
  测点编号: string
  测区: string
  监测日期: string
  本次高程: number
  本次沉降: number
  累计沉降: number
  沉降速率: number
  来源: '网关取数' | '人工补录'
  采集状态: CollectStatus
  异常原因: string
  提交人: string
}

/** 补测批次：中途中断后按 cursor 接着走，已处理测点不再重测。 */
export type CollectBatchRow = {
  id: number
  scope: string // 测区名；'ALL' 表示全部待补测测点
  监测日期: string
  状态: '进行中' | '已完成' | '已中断'
  计划测点: number[]
  完成测点: number[]
  成功测点: number[]
  异常测点: number[]
  更新时间: string
}

/** 测点台账的派生视图：由测点主数据 + 当日读数现场计算，页面只读。 */
export type PointView = EntryRow & {
  采集状态: CollectStatus
  应测日期: string
  异常原因: string
  今日累计沉降: string
  今日沉降速率: string
  报警对象编号: string
  报警对象名称: string
}

export type ZoneStatus = {
  zone: string
  state: '已采齐' | '未测量' | '未取到' | '部分异常' | '无测点'
  total: number
  collected: number
  pending: number
  failed: number
  reason: string
}

export type CollectOutcome = {
  ok: boolean
  pointId: number
  attempts: number
  reading?: ReadingRow
  reason?: string
  message: string
}
