<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>地表沉降管理</h2>
        <p class="page-desc">
          按监测频次排期取数：到点未测进待补测；取数失败自动重试（不顶上一轮累计沉降），重试仍败记异常并写明原因；累计沉降或速率越限自动报警，报警结论同步建筑监测。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">登记沉降测点</button>
        <button class="btn" type="button" @click="exportRows">导出测点清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">报警测点数（与建筑监测同口径）</span>
        <strong class="stat-value alarm">{{ stats.alarmPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待补测测点</span>
        <strong class="stat-value warn">{{ stats.duePoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">取数异常测点</span>
        <strong class="stat-value" :class="{ alarm: stats.failedPoints > 0 }">{{ stats.failedPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">预警测点 / 测点总数</span>
        <strong class="stat-value">{{ stats.warnPoints }} / {{ stats.total }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item">当前角色：{{ role === '监测负责人' ? '监测负责人（可改阈值与初始高程）' : '值班管理员（只读基线）' }}</span>
      <span class="legend-item">今天：{{ today }}</span>
      <span v-for="item in collectSummary" :key="item.label" class="legend-item" :class="item.cls">
        {{ item.label }}：{{ item.count }}
      </span>
    </p>

    <!-- 测区状态：一条都取不回来时，在这里交代是「没测量」还是「没取到」，页面不会停在加载中。 -->
    <div class="zone-grid">
      <article v-for="zone in zoneCards" :key="zone.zone" class="zone-card" :class="`zone-${zoneStateClass(zone.state)}`">
        <header class="zone-head">
          <strong>{{ zone.zone }}</strong>
          <span class="zone-state">{{ zone.state }}</span>
        </header>
        <p class="zone-reason">{{ zone.reason }}</p>
        <p class="zone-counts">
          应测 {{ zone.total }} · 已取到 {{ zone.collected }} · 未测 {{ zone.pending }} · 异常 {{ zone.failed }}
        </p>
        <button class="btn" type="button" :disabled="loadingZone === zone.zone" @click="collectZone(zone.zone)">
          {{ loadingZone === zone.zone ? '正在整区取数…' : '整区取数（首轮各试一次）' }}
        </button>
      </article>
    </div>

    <!-- 补测批次：断点进度持久化，中途中断从断掉的测点接着走，已测完的不重测。 -->
    <div class="batch-panel">
      <template v-if="batch">
        <div class="batch-head">
          <strong>
            补测批次 #{{ batch.id }}（{{ batch.scope === 'ALL' ? '全部测区' : batch.scope }}）—
            已处理 {{ batch.完成测点.length }}/{{ batch.计划测点.length }}，
            成功 {{ batch.成功测点.length }}，异常 {{ batch.异常测点.length }}，{{ batch.状态 }}
          </strong>
          <span class="batch-note">{{ batch.更新时间 }}</span>
        </div>
        <div class="progress-track">
          <span
            v-for="id in batch.计划测点"
            :key="id"
            class="progress-dot"
            :class="batch.成功测点.includes(id) ? 'ok' : batch.异常测点.includes(id) ? 'fail' : 'todo'"
            :title="pointCode(id)"
          >{{ pointCode(id).replace('SETT-', '') }}</span>
        </div>
        <div class="row-actions">
          <button v-if="batch.状态 === '已中断'" class="btn primary" type="button" @click="continueBatch">从断点继续</button>
          <template v-else>
            <button class="btn primary" type="button" :disabled="busyBatch" @click="runNext">
              {{ busyBatch ? '取数中（含失败重试）…' : '从断点补测下一点' }}
            </button>
            <button class="btn" type="button" :disabled="busyBatch" @click="runRest">一路补到完</button>
            <button class="btn ghost" type="button" @click="stopBatch">中途中断</button>
          </template>
        </div>
      </template>
      <template v-else>
        <strong>补测排期：</strong>
        <span class="page-desc">顺序由系统拍板——到期日早的先补，同日按测点编号升序；到点未测的测点如下。</span>
        <div class="row-actions batch-start">
          <button class="btn primary" type="button" @click="start('ALL')">建立全部待补测批次</button>
          <button v-for="zone in zonesWithDue" :key="zone" class="btn" type="button" @click="start(zone)">
            仅补 {{ zone }}
          </button>
        </div>
      </template>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>测区</span>
        <select v-model="zoneFilter">
          <option value="">全部测区</option>
          <option v-for="zone in allZones" :key="zone" :value="zone">{{ zone }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>测点编号 / 位置</span>
        <input v-model="keyword" placeholder="按测点编号或位置检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>监测结论</th>
          <th>采集状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)" :class="row.采集状态 === '取数异常' ? 'row-abnormal' : ''">
          <td v-for="column in columns" :key="column">{{ display(row, column) }}</td>
          <td><span :class="conclusionClass(row.status)">{{ row.status }}</span></td>
          <td>
            <span :class="collectClass(row.采集状态)">{{ row.采集状态 }}</span>
            <span v-if="row.异常原因" class="cell-reason">{{ row.异常原因 }}</span>
          </td>
          <td class="row-actions cell-actions">
            <button
              v-if="row.采集状态 !== '已采集' && row.采集状态 !== '已稳定停测'"
              class="link"
              type="button"
              :disabled="loadingId === Number(row.id)"
              @click="collectOne(Number(row.id))"
            >{{ row.采集状态 === '取数异常' ? '重试取数' : '立即取数' }}</button>
            <button class="link" type="button" @click="openManual(row)">人工补录</button>
            <button class="link" type="button" @click="openBaseline(row)">
              阈值/初始高程{{ role === '监测负责人' ? '' : '（无权限）' }}
            </button>
            <button v-if="row.status !== '已稳定'" class="link" type="button" @click="stabilize(row)">确认稳定</button>
            <button v-else class="link" type="button" @click="resume(row)">恢复监测</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">当前筛选条件下没有测点</td>
        </tr>
      </tbody>
    </table>

    <section class="reading-panel">
      <header class="batch-head">
        <strong>监测读数台账</strong>
        <span class="page-desc">同测点同一天重复提交只留一条；异常读数也记在这里并说明原因。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in readingColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredReadings" :key="row.id" :class="row.采集状态 === '取数异常' ? 'row-abnormal' : ''">
            <td v-for="column in readingColumns" :key="column">{{ (row as unknown as Record<string, string | number>)[column] || '—' }}</td>
          </tr>
          <tr v-if="!filteredReadings.length">
            <td :colspan="readingColumns.length" class="empty-state">还没有读数记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 个测点 · 数据保存在本机浏览器，点<a href="#" @click.prevent="doReset">这里</a>回到示例台账</span>
      <span v-if="message" class="foot-msg" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记测点 -->
    <div v-if="registerOpen" class="modal-mask" @click.self="registerOpen = false">
      <form class="modal" @submit.prevent="submitRegister">
        <h3>登记沉降测点（存量测点按布点日期补进台账）</h3>
        <div class="form-grid">
          <label v-for="field in registerFields" :key="field.key" class="form-item">
            <span>{{ field.label }}{{ field.required ? ' *' : '' }}</span>
            <input v-model="registerForm[field.key]" :placeholder="field.placeholder ?? ''" />
          </label>
        </div>
        <p class="form-hint">监测频次支持「1次/天」「1次/2天」；初始高程单位 m，阈值单位 mm（负值）。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="registerOpen = false">取消</button>
          <button class="btn primary" type="submit">提交登记</button>
        </div>
      </form>
    </div>

    <!-- 人工补录 -->
    <div v-if="manualOpen" class="modal-mask" @click.self="manualOpen = false">
      <form class="modal" @submit.prevent="submitManual">
        <h3>人工补录读数 — {{ manualForm.pointCode }}</h3>
        <div class="form-grid single">
          <label class="form-item">
            <span>监测日期 *</span>
            <input v-model="manualForm.date" placeholder="YYYY-MM-DD" />
          </label>
          <label class="form-item">
            <span>本次高程 (m) *</span>
            <input v-model="manualForm.elevationText" placeholder="如 5.129" />
          </label>
        </div>
        <p class="form-hint">同一测点同一天再交只会覆盖原记录，不会翻倍；校验不过或存不进去会原样退回。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="manualOpen = false">取消</button>
          <button class="btn primary" type="submit">提交读数</button>
        </div>
      </form>
    </div>

    <!-- 基线修订 -->
    <div v-if="baselineOpen" class="modal-mask" @click.self="baselineOpen = false">
      <form class="modal" @submit.prevent="submitBaseline">
        <h3>预警阈值与初始高程 — {{ baselineForm.pointCode }}</h3>
        <p v-if="role !== '监测负责人'" class="error-text">只有本项目的监测负责人能修改，当前是值班管理员，仅可查看。</p>
        <div class="form-grid single">
          <label class="form-item">
            <span>初始高程 (m)</span>
            <input v-model="baselineForm.base" :disabled="!canEdit" />
          </label>
          <label class="form-item">
            <span>累计沉降报警阈值 (mm，负值)</span>
            <input v-model="baselineForm.threshold" :disabled="!canEdit" />
          </label>
          <label class="form-item">
            <span>沉降速率报警阈值 (mm/d，负值)</span>
            <input v-model="baselineForm.rateThreshold" :disabled="!canEdit" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn" type="button" @click="baselineOpen = false">关闭</button>
          <button v-if="canEdit" class="btn primary" type="submit">保存修订</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  advanceBatch,
  canEditBaseline,
  collectPoint,
  collectZoneOnce,
  currentRole,
  exportSettlementCsv,
  interruptBatch,
  listAllReadings,
  listBatchesView,
  listPointViews,
  listZones,
  moduleMeta,
  registerPoint,
  resetModule,
  resumeableBatch,
  resumeBatch,
  runAction as applyAction,
  runBatchToEnd,
  settlementStats,
  startBatch,
  submitManualReading,
  updateBaseline,
  zoneStatusOf,
} from '@/api/local-service'
import type { CollectBatchRow, CollectOutcome, PointView, ReadingRow, ZoneStatus } from '@/data/types'

const meta = moduleMeta('settlement')
const today = '2026-10-05'

const columns = [
  '测点编号', '测点位置', '测区', '初始高程', '累计沉降', '沉降速率',
  '预警阈值', '速率报警阈值', '监测频次', '布点日期', '应测日期',
  '关联建筑编号', '关联建筑名称',
]
const readingColumns = ['测点编号', '测区', '监测日期', '本次高程', '本次沉降', '累计沉降', '沉降速率', '来源', '采集状态', '异常原因', '提交人']

const role = ref(currentRole())
const canEdit = computed(() => canEditBaseline())
const rows = ref<PointView[]>([])
const readings = ref<ReadingRow[]>([])
const allZones = ref<string[]>([])
const zones = ref<ZoneStatus[]>([])
const batch = ref<CollectBatchRow | undefined>(undefined)
const stats = ref(settlementStats(today))
const message = ref('')
const messageOk = ref(true)
const zoneFilter = ref('')
const keyword = ref('')
const loadingId = ref<number | null>(null)
const loadingZone = ref('')
const busyBatch = ref(false)

function flash(text: string, ok = true) {
  message.value = text
  messageOk.value = ok
}

const collectSummary = computed(() => {
  const count = (status: string) => rows.value.filter((row) => row.采集状态 === status).length
  return [
    { label: '今日已采集', count: count('已采集'), cls: '' },
    { label: '待补测', count: count('待补测'), cls: 'legend-warn' },
    { label: '取数异常', count: count('取数异常'), cls: 'legend-alarm' },
    { label: '稳定停测', count: count('已稳定停测'), cls: '' },
  ]
})

const zoneCards = computed(() => zones.value)
const zonesWithDue = computed(() =>
  zones.value.filter((zone) => zone.state === '未测量' || zone.state === '未取到' || zone.state === '部分异常').map((zone) => zone.zone),
)

const filteredRows = computed(() =>
  rows.value.filter((row) => {
    if (zoneFilter.value && String(row.测区) !== zoneFilter.value) {
      return false
    }
    const key = keyword.value.trim()
    if (!key) {
      return true
    }
    return String(row.测点编号).includes(key) || String(row.测点位置).includes(key)
  }),
)

const filteredReadings = computed(() =>
  [...readings.value]
    .filter((row) => !zoneFilter.value || row.测区 === zoneFilter.value)
    .filter((row) => {
      const key = keyword.value.trim()
      return !key || row.测点编号.includes(key)
    })
    .sort((a, b) => (a.监测日期 < b.监测日期 ? 1 : a.监测日期 > b.监测日期 ? -1 : a.id - b.id)),
)

function display(row: PointView, column: string): string | number {
  if (column === '累计沉降' || column === '沉降速率') {
    return row.今日累计沉降 && column === '累计沉降'
      ? `${row.累计沉降}（今日 ${row.今日累计沉降}）`
      : row.今日沉降速率 && column === '沉降速率'
        ? `${row.沉降速率}（今日 ${row.今日沉降速率}）`
        : String(row[column] ?? '—')
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : (value as string | number)
}

function conclusionClass(status: string) {
  return { 'tag-alarm': status === '报警', 'tag-warn': status === '预警', 'tag-off': status === '已稳定' }
}
function collectClass(status: string) {
  return { 'tag-alarm': status === '取数异常', 'tag-warn': status === '待补测', 'tag-ok': status === '已采集', 'tag-off': status === '已稳定停测' }
}
function zoneStateClass(state: ZoneStatus['state']) {
  return { 已采齐: 'ok', 未测量: 'idle', 未取到: 'fail', 部分异常: 'warn', 无测点: 'empty' }[state]
}
function pointCode(id: number): string {
  return String(rows.value.find((row) => Number(row.id) === id)?.测点编号 ?? `#${id}`)
}

function reload() {
  rows.value = listPointViews(today)
  allZones.value = listZones()
  zones.value = allZones.value.map((zone) => zoneStatusOf(zone, today))
  readings.value = [...allReadings()]
  stats.value = settlementStats(today)
  batch.value = resumeableBatch(today) ?? listBatchesView().find((item) => item.状态 === '已中断')
  role.value = currentRole()
}

function allReadings(): ReadingRow[] {
  // 读数明细与导出共用领域服务同一条读取路径，不在页面里另算。
  return listAllReadings()
}

function resetFilters() {
  zoneFilter.value = ''
  keyword.value = ''
}

function exportRows() {
  const { filename, content } = exportSettlementCsv()
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

function doReset() {
  resetModule(meta.key)
  reload()
  flash('已回到示例台账、读数与补测批次')
}

async function collectOne(id: number) {
  loadingId.value = id
  flash('正在取数，失败会自动重试 3 次…')
  try {
    const outcome: CollectOutcome = await collectPoint(id, today)
    flash(outcome.message, outcome.ok)
  } finally {
    loadingId.value = null
    reload()
  }
}

async function collectZone(zone: string) {
  loadingZone.value = zone
  flash(`正在对 ${zone} 整区取数…`)
  try {
    const { results, zoneStatus } = await collectZoneOnce(zone, today)
    const okCount = results.filter((item) => item.ok).length
    flash(zoneStatus.reason + `（成功 ${okCount}/${results.length}）`, okCount > 0)
  } finally {
    loadingZone.value = ''
    reload()
  }
}

function start(scope: string) {
  const result = startBatch(scope, today)
  flash(result.message, result.ok)
  reload()
}

async function runNext() {
  if (!batch.value) {
    return
  }
  busyBatch.value = true
  try {
    const result = await advanceBatch(batch.value.id, today)
    flash(result.message, result.ok)
  } finally {
    busyBatch.value = false
    reload()
  }
}

async function runRest() {
  if (!batch.value) {
    return
  }
  busyBatch.value = true
  flash('从断点续跑，已测完的测点自动跳过…')
  try {
    const finalBatch = await runBatchToEnd(batch.value.id, today)
    flash(`补测完成：成功 ${finalBatch.成功测点.length}，异常 ${finalBatch.异常测点.length}`)
  } finally {
    busyBatch.value = false
    reload()
  }
}

function stopBatch() {
  if (!batch.value) {
    return
  }
  const result = interruptBatch(batch.value.id)
  flash(result.message)
  reload()
}

function continueBatch() {
  if (!batch.value) {
    return
  }
  const result = resumeBatch(batch.value.id)
  flash(result.message, result.ok)
  reload()
}

function stabilize(row: PointView) {
  const result = applyAction(meta.key, Number(row.id), '确认稳定')
  flash(result.message, result.ok)
  reload()
}

function resume(row: PointView) {
  const result = applyAction(meta.key, Number(row.id), '恢复监测')
  flash(result.message, result.ok)
  reload()
}

// ── 登记测点 ──
const registerOpen = ref(false)
const registerFields: { key: string; label: string; required?: boolean; placeholder?: string }[] = [
  { key: 'code', label: '测点编号', required: true, placeholder: '如 SETT-0010' },
  { key: 'location', label: '测点位置', placeholder: '如 A区-右线K12+340' },
  { key: 'zone', label: '测区', required: true, placeholder: '如 A区' },
  { key: 'baseElevationText', label: '初始高程(m)', required: true, placeholder: '如 5.080' },
  { key: 'thresholdText', label: '累计沉降报警阈值(mm)', required: true, placeholder: '负值，如 -20' },
  { key: 'rateThresholdText', label: '速率报警阈值(mm/d)', required: true, placeholder: '负值，如 -3' },
  { key: 'frequency', label: '监测频次', placeholder: '1次/天 或 1次/2天' },
  { key: 'deployDate', label: '布点日期', required: true, placeholder: 'YYYY-MM-DD' },
  { key: 'buildingCode', label: '关联建筑编号', placeholder: '如 BUIL-0001' },
  { key: 'buildingName', label: '关联建筑名称', placeholder: '如 沿街便利店' },
]
const registerForm = reactive<Record<string, string>>({})
function openRegister() {
  for (const field of registerFields) {
    registerForm[field.key] = field.key === 'frequency' ? '1次/天' : field.key === 'deployDate' ? today : ''
  }
  registerOpen.value = true
}
function submitRegister() {
  const result = registerPoint({
    code: registerForm.code,
    location: registerForm.location,
    zone: registerForm.zone,
    baseElevationText: registerForm.baseElevationText,
    thresholdText: registerForm.thresholdText,
    rateThresholdText: registerForm.rateThresholdText,
    frequency: registerForm.frequency,
    deployDate: registerForm.deployDate,
    buildingCode: registerForm.buildingCode,
    buildingName: registerForm.buildingName,
  })
  flash(result.message, result.ok)
  if (result.ok) {
    registerOpen.value = false
    reload()
  }
}

// ── 人工补录 ──
const manualOpen = ref(false)
const manualForm = reactive<{ pointId: number; pointCode: string; date: string; elevationText: string }>({
  pointId: 0, pointCode: '', date: today, elevationText: '',
})
function openManual(row: PointView) {
  manualForm.pointId = Number(row.id)
  manualForm.pointCode = String(row.测点编号)
  manualForm.date = row.应测日期 || today
  manualForm.elevationText = ''
  manualOpen.value = true
}
function submitManual() {
  const result = submitManualReading({
    pointId: manualForm.pointId,
    date: manualForm.date,
    elevationText: manualForm.elevationText,
  })
  flash(result.message, result.ok)
  if (result.ok) {
    manualOpen.value = false
    reload()
  } else if (result.returned) {
    manualForm.date = result.returned.date
    manualForm.elevationText = result.returned.elevationText
  }
}

// ── 基线修订 ──
const baselineOpen = ref(false)
const baselineForm = reactive<{ pointId: number; pointCode: string; base: string; threshold: string; rateThreshold: string }>({
  pointId: 0, pointCode: '', base: '', threshold: '', rateThreshold: '',
})
function openBaseline(row: PointView) {
  baselineForm.pointId = Number(row.id)
  baselineForm.pointCode = String(row.测点编号)
  baselineForm.base = String(row.初始高程)
  baselineForm.threshold = String(row.预警阈值)
  baselineForm.rateThreshold = String(row.速率报警阈值)
  baselineOpen.value = true
}
function submitBaseline() {
  const result = updateBaseline(baselineForm.pointId, {
    初始高程: Number(baselineForm.base),
    预警阈值: Number(baselineForm.threshold),
    速率报警阈值: Number(baselineForm.rateThreshold),
  })
  flash(result.message, result.ok)
  if (result.ok) {
    baselineOpen.value = false
    reload()
  }
}

onMounted(reload)
</script>
