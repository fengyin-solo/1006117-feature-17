<template>
  <section class="page" data-module="building">
    <header class="page-head">
      <div>
        <h2>建筑监测管理</h2>
        <p class="page-desc">
          报警结论不手工发布、也不在本页另记一份：统一以地表沉降测点清单为准，按监测对象汇总报警测点，
          与沉降页、运营概览读到的报警测点数始终一致。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出监测对象清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="item.tone">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>对象编号 / 名称</span>
        <input v-model="keyword" placeholder="按对象编号或建筑物名称检索" />
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option value="待布点">待布点</option>
          <option value="监测中">监测中</option>
          <option value="已报警">已报警</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>监测状态（测点派生）</th>
          <th>报警测点</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in filteredViews" :key="String(view.row.id)" :class="{ 'row-alarm': view.status === '已报警' }">
          <td>{{ view.row['对象编号'] }}</td>
          <td>{{ view.row['建筑物名称'] }}</td>
          <td>{{ view.row['结构类型'] }}</td>
          <td>{{ view.row['距隧道距离'] }}</td>
          <td>{{ view.row['允许沉降'] }} mm</td>
          <td>{{ view.row['默认监测频次'] }}</td>
          <td>{{ view.row['布点日期'] }}</td>
          <td>
            <span class="status-pill" :data-status="view.status">{{ view.status }}</span>
            <p class="cell-note">关联测点 {{ view.pointCount }} 个 · 最大累计沉降 {{ view.maxCumulative === null ? '—' : view.maxCumulative.toFixed(1) + ' mm' }}</p>
          </td>
          <td>
            <button class="link" type="button" @click="toggle(String(view.row['对象编号']))">
              {{ view.alarmCount }} 个{{ expanded === view.row['对象编号'] ? '（收起）' : '（查看）' }}
            </button>
            <ul v-if="expanded === view.row['对象编号']" class="alarm-point-list">
              <li v-for="point in view.alarmPoints" :key="String(point.row.id)">
                <strong>{{ point.row['测点编号'] }}</strong>
                <span>{{ point.row['测点位置'] }}</span>
                <span class="alarm-text">{{ point.derived.alarmReasons.join('；') }}</span>
              </li>
              <li v-if="!view.alarmPoints.length" class="cell-note">暂无越限测点</li>
            </ul>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td :colspan="columns.length + 2" class="empty-state">当前条件下没有监测对象</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>报警测点口径与「地表沉降」页完全相同（共 {{ monitorSummary.alarmPointCount }} 个 / {{ monitorSummary.alarmObjectCount }} 个对象）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadCsv,
  getMonitoringSummary,
  listObjectViews,
} from '@/api/monitor-service'
import { exportEntries, moduleMeta } from '@/api/local-service'
import type { MonitoringSummary, ObjectView } from '@/data/types'

const meta = moduleMeta('building')
const columns = ['对象编号', '建筑物名称', '结构类型', '距隧道距离', '允许沉降', '默认监测频次', '布点日期']

const views = ref<ObjectView[]>([])
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
  asOf: '',
})
const monitorSummary = summary
const keyword = ref('')
const statusFilter = ref('')
const expanded = ref<string | number | null>(null)
const errorMessage = ref('')

const filteredViews = computed(() =>
  views.value.filter((view) => {
    const key = keyword.value.trim()
    if (key && ![view.row['对象编号'], view.row['建筑物名称']].some((value) => String(value ?? '').includes(key))) {
      return false
    }
    if (statusFilter.value && view.status !== statusFilter.value) {
      return false
    }
    return true
  }),
)

const stats = computed(() => [
  {
    label: '监测中对象',
    value: views.value.filter((view) => view.status === '监测中').length,
    tone: '',
  },
  {
    label: '报警对象（测点越限派生）',
    value: summary.value?.alarmObjectCount ?? 0,
    tone: 'tone-alarm',
  },
  {
    label: '报警测点（与沉降页同源）',
    value: summary.value?.alarmPointCount ?? 0,
    tone: 'tone-alarm',
  },
  {
    label: '待布点对象',
    value: views.value.filter((view) => view.status === '待布点').length,
    tone: '',
  },
])

function toggle(code: string | number) {
  expanded.value = expanded.value === code ? null : code
}

function resetFilters() {
  keyword.value = ''
  statusFilter.value = ''
}

function exportRows() {
  const { filename, content } = exportEntries(meta.key)
  downloadCsv(filename, content)
}

function reload() {
  errorMessage.value = ''
  views.value = listObjectViews()
  summary.value = getMonitoringSummary()
}

onMounted(reload)
</script>

<style scoped>
.tone-alarm { border-left: 3px solid #dc2626; }
.alarm-text { color: #b42318; font-weight: 600; }
.row-alarm { background: #fff7f7; }
.status-pill {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #eef2f7;
}
.status-pill[data-status='已报警'] { background: #fee2e2; color: #b42318; }
.status-pill[data-status='待布点'] { background: #fef3c7; color: #92400e; }
.cell-note { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.alarm-point-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 8px;
  background: #fff7f7;
  border: 1px solid #fecaca;
  border-radius: 6px;
  min-width: 320px;
}
.alarm-point-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px dashed #fecaca;
}
.alarm-point-list li:last-child { border-bottom: none; }
</style>
