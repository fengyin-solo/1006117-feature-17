<template>
  <section class="page" data-module="building">
    <header class="page-head">
      <div>
        <h2>建筑监测管理</h2>
        <p class="page-desc">
          维护监测对象登记。报警结论由地表沉降台账自动落到本清单，报警测点数两处读同一份统计，不另算。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记监测对象</button>
        <button class="btn" type="button" @click="exportRows">导出建筑监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">报警测点数（读地表沉降同一份）</span>
        <strong class="stat-value alarm">{{ stats.alarmPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">报警对象数</span>
        <strong class="stat-value" :class="{ alarm: alarmObjectCount > 0 }">{{ alarmObjectCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">监测中对象</span>
        <strong class="stat-value">{{ monitoringCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待补测 / 取数异常测点</span>
        <strong class="stat-value">{{ stats.duePoints }} / {{ stats.failedPoints }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item">口径说明：本页「报警测点数」与地表沉降页完全一致，均来自沉降测点记录，页面不重复计算。</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>报警测点数</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="row.status === '已报警' ? 'row-abnormal' : ''">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <strong :class="alarmCount(row) > 0 ? 'tag-alarm' : ''">{{ alarmCount(row) }}</strong>
            <span class="cell-reason">/ {{ totalCount(row) }} 个关联测点</span>
          </td>
          <td>
            <span :class="conclusionClass(row.status)">{{ row.status }}</span>
            <span class="cell-reason">{{ row.监测状态 }}</span>
          </td>
          <td class="row-actions">
            <button
              v-if="row.status === '待布点'"
              class="link"
              type="button"
              @click="runAction('布设测点', row)"
            >布设测点</button>
            <button
              v-if="row.status === '已报警'"
              class="link"
              type="button"
              @click="runAction('解除报警', row)"
            >解除报警</button>
            <span v-if="row.status !== '待布点' && row.status !== '已报警'" class="page-desc">由沉降数据联动</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无建筑监测数据，可先登记监测对象</td>
        </tr>
      </tbody>
    </table>

    <!-- 报警落到对象清单：按对象汇总，直接读沉降统计 -->
    <section class="reading-panel">
      <header class="batch-head">
        <strong>报警结论落点（与地表沉降同一数据源）</strong>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>对象编号</th><th>建筑物名称</th><th>关联测点</th><th>报警测点</th><th>结论</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in stats.alarmByBuilding" :key="item.code">
            <td>{{ item.code }}</td>
            <td>{{ item.name }}</td>
            <td>{{ item.total }}</td>
            <td><strong :class="item.alarm > 0 ? 'tag-alarm' : ''">{{ item.alarm }}</strong></td>
            <td :class="item.alarm > 0 ? 'tag-alarm' : 'tag-ok'">
              {{ item.alarm > 0 ? `${item.alarm} 个测点越限，已自动报警` : '测点在限值以内' }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条建筑监测记录 · 在地表沉降页修改数据后回本页即同步</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  settlementStats,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('building')
const columns = ['对象编号', '建筑物名称', '结构类型', '距隧道距离', '允许沉降', '实测沉降', '监测频次', '关联测区']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['对象编号', '建筑物名称']
const stats = ref(settlementStats())

const alarmMap = computed(() => {
  const map = new Map<string, { alarm: number; total: number }>()
  for (const item of stats.value.alarmByBuilding) {
    map.set(item.code, { alarm: item.alarm, total: item.total })
  }
  return map
})

const alarmObjectCount = computed(
  () => rows.value.filter((row) => (alarmMap.value.get(String(row.对象编号))?.alarm ?? 0) > 0).length,
)
const monitoringCount = computed(
  () => rows.value.filter((row) => row.status === '监测中' || row.status === '已报警').length,
)

function alarmCount(row: EntryRow): number {
  return alarmMap.value.get(String(row.对象编号))?.alarm ?? 0
}
function totalCount(row: EntryRow): number {
  return alarmMap.value.get(String(row.对象编号))?.total ?? 0
}
function conclusionClass(status: string) {
  return { 'tag-alarm': status === '已报警', 'tag-ok': status === '已解除' }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '监测对象登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = settlementStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '建筑监测列表读取失败'
  }
}

onMounted(reload)
</script>
