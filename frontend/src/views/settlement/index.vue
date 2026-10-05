<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>地表沉降管理</h2>
        <p class="page-desc">
          按监测频次自动排期，到点未测进待补测；取数失败重试 2 次仍失败只记异常、不顶上轮累计；
          报警以测点累计沉降与沉降速率越限自动产生，建筑监测页与运营概览读同一份。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openDeploy">登记 / 补录测点</button>
        <button class="btn" type="button" @click="exportRows">导出测点清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="item.tone">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 取数演练开关：复现整区未测 / 整区取数失败 / 单点失败，验收用 -->
    <div class="sim-bar">
      <span class="sim-label">取数链路演练：</span>
      <button
        v-for="option in scenarioOptions"
        :key="option.key"
        class="btn"
        :class="{ primary: scenario.kind === option.match }"
        type="button"
        @click="applyScenario(option.key)"
      >
        {{ option.label }}
      </button>
      <span class="sim-hint">{{ scenarioHint }}</span>
    </div>

    <!-- 测区状态：整片一条都取不回来时，在这里交代是没测量还是没取到 -->
    <div class="area-row">
      <article v-for="area in areas" :key="area.area" class="area-card" :class="areaEventType(area)">
        <header>
          <strong>{{ area.area }}</strong>
          <span class="area-count">{{ area.measuredToday }}/{{ area.total }} 已测</span>
        </header>
        <p v-if="area.event" class="area-event" :data-kind="area.event.kind">
          {{ area.event.kind === 'not-measured' ? '今日没测量' : '取数失败' }}：{{ area.event.reason }}
        </p>
        <p v-else-if="area.due > 0" class="area-due">今日 {{ area.due }} 个测点到点，等待取数/补测</p>
        <p v-else class="area-ok">本测区今日无到期测点</p>
        <footer>数据截至 {{ area.latestDate || '—' }}</footer>
      </article>
    </div>

    <div class="batch-bar">
      <button class="btn primary" type="button" :disabled="batchRunning" @click="startBatch()">
        按频次统一取数（含待补测）{{ filters['测区'] ? `· 仅${filters['测区']}` : '' }}
      </button>
      <button class="btn" type="button" :disabled="batchRunning" @click="resumeBatch">从中断测点继续</button>
      <button class="btn ghost" type="button" :disabled="!batchRunning" @click="stopBatch">停止补测</button>
      <span v-if="progress" class="batch-progress">
        进度 {{ progress.done }}/{{ progress.total }}
        （成功 {{ progress.success }} · 失败 {{ progress.failed }} · 跳过 {{ progress.skipped }}）
        当前：{{ progress.currentCode || '—' }}
        <em v-if="progress.interrupted">已中断，可从 {{ progress.currentCode }} 接着走，已测的不重测</em>
      </span>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>测区</span>
        <select v-model="filters['测区']">
          <option value="">全部</option>
          <option v-for="area in areaNames" :key="area" :value="area">{{ area }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="filters['状态']">
          <option value="">全部</option>
          <option v-for="status in statusOptions" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>测点编号 / 位置 / 对象</span>
        <input v-model="filters['关键字']" placeholder="按编号、位置或对象检索" @input="reload" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 整片空态横幅：当前测区一条都取不回来时，写清是没测量还是没取到，不再停在加载中 -->
    <div v-if="zoneBanner" class="zone-empty" :data-kind="zoneBanner.kind">
      <strong>{{ zoneBanner.title }}</strong>
      <p>{{ zoneBanner.reason }}</p>
      <p class="zone-empty-sub">{{ zoneBanner.sub }}</p>
    </div>

    <!-- 无横幅但筛选结果为空时才整块替换表格 -->
    <div v-else-if="emptyBlock" class="zone-empty" :data-kind="emptyBlock.kind">
      <strong>{{ emptyBlock.title }}</strong>
      <p>{{ emptyBlock.reason }}</p>
      <p class="zone-empty-sub">{{ emptyBlock.sub }}</p>
    </div>

    <table v-else class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>处置</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in effectiveViews" :key="String(view.row.id)" :class="rowClass(view.derived.status)">
          <td>{{ view.row['测点编号'] }}</td>
          <td>{{ view.row['测点位置'] }}</td>
          <td>{{ view.row['所属对象'] || '—' }}</td>
          <td>{{ view.row['测区'] }}</td>
          <td>{{ view.row['初始高程'] }}</td>
          <td>{{ view.row['当前高程'] ?? view.row['初始高程'] }}</td>
          <td :class="{ 'alarm-text': view.derived.alarm }">
            {{ fmt(view.row['累计沉降']) }}
          </td>
          <td :class="{ 'alarm-text': view.derived.alarm }">{{ fmt(view.row['沉降速率']) }}</td>
          <td>
            {{ view.row['预警阈值'] }} / {{ view.row['速率限值'] }}
            <button class="link" type="button" @click="openThreshold(view.row)">改</button>
          </td>
          <td>{{ view.row['监测频次'] }}</td>
          <td>{{ view.row['布点日期'] }}</td>
          <td>{{ view.row['最近监测'] || '—' }}</td>
          <td>
            <span class="status-pill" :data-status="view.derived.status">{{ view.derived.status }}</span>
            <p v-if="view.derived.status === '待补测'" class="cell-note">
              应测 {{ view.derived.nextDueDate }}<template v-if="view.derived.overdueDays">，已逾期 {{ view.derived.overdueDays }} 天</template>
            </p>
            <p v-if="view.derived.alarm" class="cell-note alarm-text">
              {{ view.derived.alarmReasons.join('；') }}
            </p>
            <p v-if="view.derived.openFailure" class="cell-note error-text">
              取数异常：{{ view.derived.openFailure.reason }}
            </p>
          </td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="batchRunning" @click="fetchOne(view.row)">立即取数</button>
            <button class="link" type="button" @click="openReading(view.row)">人工补测</button>
            <button
              v-if="view.derived.status === '已稳定'"
              class="link"
              type="button"
              @click="toggleStable(view.row, false)"
            >
              恢复监测
            </button>
            <button
              v-else
              class="link"
              type="button"
              @click="toggleStable(view.row, true)"
            >
              确认稳定
            </button>
            <button class="link" type="button" @click="openInitial(view.row)">初始高程</button>
          </td>
        </tr>
        <tr v-if="!effectiveViews.length">
          <td :colspan="columns.length + 2" class="empty-state">
            当前筛选条件下没有测点，请调整测区或状态条件
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ effectiveViews.length }} 个测点 · 数据截至 {{ summary.latestDataDate || '—' }}（统计基准日 {{ summary.asOf }}）
      </span>
      <span v-if="notice" :class="notice.ok ? 'ok-text' : 'error-text'">{{ notice.text }}</span>
    </footer>

    <!-- 手工补测读数 -->
    <div v-if="readingModal.show" class="modal-mask" @click.self="closeModals">
      <div class="modal">
        <h3>人工补测 · {{ readingModal.code }}</h3>
        <p class="modal-note">同一测点同一天重复提交只保留一条；存不进去原样退回，不会生成半条。</p>
        <label class="modal-field">
          <span>监测日期</span>
          <input v-model="readingModal.date" type="date" />
        </label>
        <label class="modal-field">
          <span>实测高程 (m)</span>
          <input v-model.number="readingModal.elevation" type="number" step="0.0001" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
          <button class="btn primary" type="button" @click="submitReadingModal">提交补测</button>
        </div>
      </div>
    </div>

    <!-- 布点 / 存量补录 -->
    <div v-if="deployModal.show" class="modal-mask" @click.self="closeModals">
      <div class="modal">
        <h3>登记 / 补录沉降测点</h3>
        <p class="modal-note">存量测点按布点日期补进台账，首测应测日 = 布点日期 + 监测频次。</p>
        <div class="modal-grid">
          <label class="modal-field">
            <span>测点编号 *</span>
            <input v-model="deployModal.code" placeholder="如 SETT-0008" />
          </label>
          <label class="modal-field">
            <span>测点位置</span>
            <input v-model="deployModal.location" placeholder="如 B区 右线 K12+500" />
          </label>
          <label class="modal-field">
            <span>所属对象</span>
            <select v-model="deployModal.owner">
              <option value="">无（直接按测点阈值控制）</option>
              <option v-for="obj in objectCodes" :key="obj" :value="obj">{{ obj }}</option>
            </select>
          </label>
          <label class="modal-field">
            <span>测区</span>
            <input v-model="deployModal.area" placeholder="如 A区" />
          </label>
          <label class="modal-field">
            <span>初始高程 (m) *</span>
            <input v-model.number="deployModal.initialElevation" type="number" step="0.0001" />
          </label>
          <label class="modal-field">
            <span>累计沉降限值 (mm)</span>
            <input v-model.number="deployModal.cumulativeThreshold" type="number" step="0.1" />
          </label>
          <label class="modal-field">
            <span>速率限值 (mm/d)</span>
            <input v-model.number="deployModal.rateThreshold" type="number" step="0.1" />
          </label>
          <label class="modal-field">
            <span>监测频次</span>
            <select v-model="deployModal.frequency">
              <option value="">沿用所属对象默认</option>
              <option v-for="freq in frequencyOptions" :key="freq" :value="freq">{{ freq }}</option>
            </select>
          </label>
          <label class="modal-field">
            <span>布点日期 *</span>
            <input v-model="deployModal.deployDate" type="date" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
          <button class="btn primary" type="button" @click="submitDeploy">补进台账</button>
        </div>
      </div>
    </div>

    <!-- 阈值调整（仅监测负责人） -->
    <div v-if="thresholdModal.show" class="modal-mask" @click.self="closeModals">
      <div class="modal">
        <h3>调整预警阈值 · {{ thresholdModal.code }}</h3>
        <p v-if="!store.isMonitorLead" class="modal-note error-text">
          只有本项目监测负责人可以修改预警阈值，当前身份是「{{ store.role }}」，不能保存。
        </p>
        <p v-else class="modal-note">仅监测负责人可改；所属对象的「允许沉降」优先于测点累计阈值。</p>
        <label class="modal-field">
          <span>累计沉降限值 (mm)</span>
          <input v-model.number="thresholdModal.cumulative" type="number" step="0.1" :disabled="!store.isMonitorLead" />
        </label>
        <label class="modal-field">
          <span>沉降速率限值 (mm/d)</span>
          <input v-model.number="thresholdModal.rate" type="number" step="0.1" :disabled="!store.isMonitorLead" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
          <button class="btn primary" type="button" :disabled="!store.isMonitorLead" @click="submitThreshold">保存</button>
        </div>
      </div>
    </div>

    <!-- 初始高程调整（仅监测负责人） -->
    <div v-if="initialModal.show" class="modal-mask" @click.self="closeModals">
      <div class="modal">
        <h3>调整初始高程 · {{ initialModal.code }}</h3>
        <p v-if="!store.isMonitorLead" class="modal-note error-text">
          只有本项目监测负责人可以修改初始高程，当前身份是「{{ store.role }}」，不能保存。
        </p>
        <p v-else class="modal-note">保存后按当前高程重算累计沉降，报警结论即时联动。</p>
        <label class="modal-field">
          <span>初始高程 (m)</span>
          <input v-model.number="initialModal.elevation" type="number" step="0.0001" :disabled="!store.isMonitorLead" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
          <button class="btn primary" type="button" :disabled="!store.isMonitorLead" @click="submitInitial">保存</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  activeCursor,
  deployPoint,
  downloadCsv,
  exportSettlement,
  fetchPointNow,
  getScenario,
  listAreaStatuses,
  listPointViews,
  getMonitoringSummary,
  requestStop,
  resumeDueFetch,
  setScenario,
  setStable,
  submitReading,
  updateInitialElevation,
  updateThresholds,
  today,
} from '@/api/monitor-service'
import { listRows } from '@/data/local-store'
import type {
  Actor,
  AreaStatus,
  BatchProgress,
  EntryRow,
  MonitoringSummary,
  PointView,
  ScenarioSpec,
} from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const columns = [
  '测点编号',
  '测点位置',
  '所属对象',
  '测区',
  '初始高程',
  '当前高程',
  '累计沉降(mm)',
  '沉降速率(mm/d)',
  '累计/速率限值(mm)',
  '监测频次',
  '布点日期',
  '最近监测',
]
const statusOptions = ['正常', '待补测', '取数异常', '报警', '已稳定']
const frequencyOptions = ['1次/天', '1次/2天', '1次/3天', '1次/7天']

const views = ref<PointView[]>([])
const areas = ref<AreaStatus[]>([])
const summary = ref<MonitoringSummary>({
  totalPoints: 0,
  normalCount: 0,
  dueCount: 0,
  fetchErrorCount: 0,
  alarmPointCount: 0,
  stableCount: 0,
  alarmObjectCount: 0,
  objectCount: 0,
  latestDataDate: '',
  asOf: today(),
})
const notice = ref<{ ok: boolean; text: string } | null>(null)
const batchRunning = ref(false)
const progress = ref<BatchProgress | null>(null)
const filters = reactive<Record<string, string>>({ 测区: '', 状态: '', 关键字: '' })

const stats = computed(() => [
  { label: '正常测点', value: summary.value.normalCount, tone: '' },
  { label: '到点未测（待补测）', value: summary.value.dueCount, tone: 'tone-due' },
  { label: '取数异常测点', value: summary.value.fetchErrorCount, tone: 'tone-error' },
  { label: '报警测点', value: summary.value.alarmPointCount, tone: 'tone-alarm' },
  { label: '关联报警对象', value: summary.value.alarmObjectCount, tone: 'tone-alarm' },
  { label: '已稳定测点', value: summary.value.stableCount, tone: '' },
])

const areaNames = computed(() => areas.value.map((item) => item.area))
const objectCodes = computed(() =>
  listRows('building').map((row) => String(row['对象编号'] ?? '')).filter(Boolean),
)

// 关键字要在编号/位置/对象三列里做 OR，其它过滤走服务。
const effectiveViews = computed(() => {
  const keyword = filters['关键字'].trim()
  if (!keyword) {
    return views.value
  }
  return views.value.filter((view) => {
    const row = view.row
    return [row['测点编号'], row['测点位置'], row['所属对象']].some((value) =>
      String(value ?? '').includes(keyword),
    )
  })
})

const scenario = ref<ScenarioSpec>(getScenario())
const scenarioOptions: { key: string; match: ScenarioSpec['kind']; label: string }[] = [
  { key: 'normal', match: 'normal', label: '正常链路' },
  { key: 'area-not-measured', match: 'area-not-measured', label: '整区今日未测' },
  { key: 'area-fetch-failed', match: 'area-fetch-failed', label: '整区取数失败' },
  { key: 'point-failed', match: 'point-failed', label: '单点取数失败' },
] as const

const scenarioHint = computed(() => {
  const spec = scenario.value
  if (spec.kind === 'normal') {
    return '取数链路正常'
  }
  if (spec.kind === 'area-not-measured') {
    return `演练：${spec.area} 今日没安排测量`
  }
  if (spec.kind === 'area-fetch-failed') {
    return `演练：${spec.area} 采集网关失败`
  }
  return `演练：测点 ${spec.pointCode} 终端无响应`
})

const readingModal = reactive({ show: false, code: '', date: today(), elevation: 0 })
const deployModal = reactive({
  show: false,
  code: '',
  location: '',
  owner: '',
  area: '',
  initialElevation: 0,
  cumulativeThreshold: 25,
  rateThreshold: 3,
  frequency: '',
  deployDate: today(),
})
const thresholdModal = reactive({ show: false, code: '', cumulative: 0, rate: 0 })
const initialModal = reactive({ show: false, code: '', elevation: 0 })

function actor(): Actor {
  return { name: store.operator, role: store.role }
}

function fmt(value: unknown): string {
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(1) : '—'
}

function rowClass(status: string): string {
  return `row-${status}`
}

function areaEventType(area: AreaStatus): string {
  return area.event ? `event-${area.event.kind}` : area.due > 0 ? 'event-due' : 'event-ok'
}

function buildZoneNotice(area: AreaStatus | undefined) {
  if (area?.event?.kind === 'not-measured') {
    return {
      kind: 'not-measured' as const,
      title: `${area.area} 今日没有测量数据`,
      reason: area.event.reason,
      sub: '这是“没测量”，不是取数失败：监测班组未提交测回，可安排人工补测后再取。',
    }
  }
  if (area?.event?.kind === 'fetch-failed') {
    return {
      kind: 'fetch-failed' as const,
      title: `${area.area} 的读数一个都没取回来`,
      reason: area.event.reason,
      sub: '这是“没取到”，不是没测量：现场已测，但采集链路失败；可稍后重试，上轮累计未被顶替。',
    }
  }
  return null
}

// 横幅：只要当前测区今天整片没测/整片失败，即使列表里还有历史行，也要把原因交代出来。
const zoneBanner = computed(() => {
  const selectedArea = filters['测区']
  if (!selectedArea) {
    return null
  }
  return buildZoneNotice(areas.value.find((item) => item.area === selectedArea))
})

// 表格整块空态：筛选后一条行都没有，且测区有区级事件。
const emptyBlock = computed(() => {
  const selectedArea = filters['测区']
  if (!selectedArea || effectiveViews.value.length > 0) {
    return null
  }
  return buildZoneNotice(areas.value.find((item) => item.area === selectedArea))
})

function notify(ok: boolean, text: string) {
  notice.value = { ok, text }
}

function reload() {
  const serviceFilters: Record<string, string> = {}
  if (filters['测区']) {
    serviceFilters['测区'] = filters['测区']
  }
  if (filters['状态']) {
    serviceFilters['状态'] = filters['状态']
  }
  const payload = listPointViews(serviceFilters)
  views.value = payload.items
  areas.value = listAreaStatuses()
  summary.value = getMonitoringSummary()
  scenario.value = getScenario()
}

function resetFilters() {
  filters['测区'] = ''
  filters['状态'] = ''
  filters['关键字'] = ''
  reload()
}

function exportRows() {
  const { filename, content } = exportSettlement()
  downloadCsv(filename, content)
}

function applyScenario(key: string) {
  let next: ScenarioSpec = { kind: 'normal' }
  if (key === 'area-not-measured') {
    next = { kind: 'area-not-measured', area: filters['测区'] || 'A区' }
  } else if (key === 'area-fetch-failed') {
    next = { kind: 'area-fetch-failed', area: filters['测区'] || 'A区' }
  } else if (key === 'point-failed') {
    next = { kind: 'point-failed', pointCode: views.value[0]?.row['测点编号'] ? String(views.value[0].row['测点编号']) : 'SETT-0001' }
  }
  setScenario(next)
  scenario.value = next
  notify(true, `已切换取数演练场景：${scenarioHint.value}`)
}

function handleBatch(area: string | null, resume = false) {
  batchRunning.value = true
  notice.value = null
  window.setTimeout(() => {
    try {
      const result = resumeDueFetch(actor(), area, (p) => {
        progress.value = p
      })
      progress.value = result
      if (result.interrupted) {
        notify(false, `补测已在 ${result.currentCode} 中断，已测 ${result.success} 个，可接着走且不重测`)
      } else {
        const blockText = result.areaBlocks
          .map((block) => `${block.area}${block.kind === 'not-measured' ? '今日没测量' : '整区取数失败'}`)
          .join('；')
        const text = `本轮取数完成：成功 ${result.success}，失败 ${result.failed}，跳过 ${result.skipped}${blockText ? `；${blockText}` : ''}`
        notify(result.failed === 0 && result.areaBlocks.length === 0, text)
      }
    } catch (error) {
      notify(false, error instanceof Error ? error.message : '取数过程异常')
    } finally {
      batchRunning.value = false
      reload()
    }
  }, 30)
}

function startBatch() {
  const area = filters['测区'] || null
  const cursor = activeCursor()
  if (cursor?.interrupted) {
    notify(false, '存在中断的补测，已为你从断点继续；已测测点不会重测')
  }
  handleBatch(area)
}

function resumeBatch() {
  // 从中断批次继续：沿用中断时的测区范围，不被当前筛选改变。
  handleBatch(null, true)
}

function stopBatch() {
  requestStop()
  notify(false, '停止信号已发出，当前测点走完即停，游标已保存')
}

function fetchOne(row: EntryRow) {
  const result = fetchPointNow(String(row['测点编号']), actor())
  notify(result.ok, result.message)
  reload()
}

function openReading(row: EntryRow) {
  readingModal.show = true
  readingModal.code = String(row['测点编号'])
  readingModal.date = today()
  readingModal.elevation = Number(row['当前高程']) || Number(row['初始高程']) || 0
}

function submitReadingModal() {
  const result = submitReading(
    {
      pointCode: readingModal.code,
      measureDate: readingModal.date,
      elevation: readingModal.elevation,
      source: '人工补测',
    },
    actor(),
  )
  notify(result.ok, result.message)
  if (result.ok) {
    closeModals()
  }
  reload()
}

function openDeploy() {
  deployModal.show = true
}

function submitDeploy() {
  const result = deployPoint(
    {
      code: deployModal.code,
      location: deployModal.location,
      owner: deployModal.owner,
      area: deployModal.area,
      initialElevation: Number(deployModal.initialElevation),
      cumulativeThreshold: Number(deployModal.cumulativeThreshold) || 25,
      rateThreshold: Number(deployModal.rateThreshold) || 3,
      frequency: deployModal.frequency,
      deployDate: deployModal.deployDate,
    },
    actor(),
  )
  notify(result.ok, result.message)
  if (result.ok) {
    closeModals()
  }
  reload()
}

function openThreshold(row: EntryRow) {
  thresholdModal.show = true
  thresholdModal.code = String(row['测点编号'])
  thresholdModal.cumulative = Number(row['预警阈值'])
  thresholdModal.rate = Number(row['速率限值'])
}

function submitThreshold() {
  const result = updateThresholds(
    thresholdModal.code,
    { cumulative: Number(thresholdModal.cumulative), rate: Number(thresholdModal.rate) },
    actor(),
  )
  notify(result.ok, result.message)
  if (result.ok) {
    closeModals()
  }
  reload()
}

function openInitial(row: EntryRow) {
  initialModal.show = true
  initialModal.code = String(row['测点编号'])
  initialModal.elevation = Number(row['初始高程'])
}

function submitInitial() {
  const result = updateInitialElevation(initialModal.code, Number(initialModal.elevation), actor())
  notify(result.ok, result.message)
  if (result.ok) {
    closeModals()
  }
  reload()
}

function toggleStable(row: EntryRow, stable: boolean) {
  const result = setStable(String(row['测点编号']), stable, actor())
  notify(result.ok, result.message)
  reload()
}

function closeModals() {
  readingModal.show = false
  deployModal.show = false
  thresholdModal.show = false
  initialModal.show = false
}

onMounted(reload)
</script>

<style scoped>
.tone-due { border-left: 3px solid #d97706; }
.tone-error { border-left: 3px solid #b42318; }
.tone-alarm { border-left: 3px solid #dc2626; }
.alarm-text { color: #b42318; font-weight: 600; }
.ok-text { color: #047857; }

.sim-bar,
.batch-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  font-size: 13px;
}
.sim-label { font-weight: 600; }
.sim-hint { color: var(--muted); }
.batch-progress { color: var(--muted); }
.batch-progress em { color: #b42318; font-style: normal; margin-left: 8px; }

.area-row { display: flex; gap: 12px; margin-bottom: 12px; }
.area-card {
  flex: 1;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.area-card header { display: flex; justify-content: space-between; font-size: 13px; }
.area-count { color: var(--muted); font-size: 12px; }
.area-card p { margin: 6px 0; font-size: 12px; }
.area-card footer { color: var(--muted); font-size: 12px; }
.area-card.event-not-measured { border-color: #d97706; background: #fffbeb; }
.area-card.event-fetch-failed { border-color: #b42318; background: #fef3f2; }
.area-card.event-due { border-color: #fcd34d; }
.area-event { font-weight: 600; }
.area-event[data-kind='not-measured'] { color: #b45309; }
.area-event[data-kind='fetch-failed'] { color: #b42318; }
.area-due { color: #92400e; }
.area-ok { color: var(--muted); }

.zone-empty {
  border: 1px dashed var(--border);
  background: #fff;
  border-radius: 8px;
  padding: 28px;
  text-align: center;
  margin-bottom: 12px;
}
.zone-empty[data-kind='not-measured'] { border-color: #d97706; background: #fffbeb; }
.zone-empty[data-kind='fetch-failed'] { border-color: #b42318; background: #fef3f2; }
.zone-empty p { margin: 6px 0; }
.zone-empty-sub { color: var(--muted); font-size: 13px; }

.status-pill {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #eef2f7;
}
.status-pill[data-status='报警'] { background: #fee2e2; color: #b42318; }
.status-pill[data-status='取数异常'] { background: #fef3c7; color: #92400e; }
.status-pill[data-status='待补测'] { background: #ffedd5; color: #c2410c; }
.status-pill[data-status='已稳定'] { background: #dcfce7; color: #166534; }
.cell-note { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.row-报警 { background: #fff7f7; }
.row-取数异常 { background: #fffdf5; }
.row-待补测 { background: #fffaf0; }

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  width: 520px;
  max-width: calc(100vw - 40px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
}
.modal h3 { margin: 0 0 8px; }
.modal-note { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.modal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.modal-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
.modal-field input,
.modal-field select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
