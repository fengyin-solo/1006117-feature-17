<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <!-- 地表沉降联动统计：与沉降页、建筑监测页同读 getMonitoringSummary，不各算一遍 -->
    <section class="link-panel">
      <header class="link-head">
        <h3>地表沉降监测联动（报警口径与沉降页、建筑监测页同源）</h3>
        <span class="link-asof">统计基准日 {{ monitor.asOf }} · 数据截至 {{ monitor.latestDataDate || '—' }}</span>
      </header>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">测点总数</span>
          <strong class="stat-value">{{ monitor.totalPoints }}</strong>
        </article>
        <article class="stat-card tone-due">
          <span class="stat-label">到点未测（待补测）</span>
          <strong class="stat-value">{{ monitor.dueCount }}</strong>
        </article>
        <article class="stat-card tone-error">
          <span class="stat-label">取数异常测点</span>
          <strong class="stat-value">{{ monitor.fetchErrorCount }}</strong>
        </article>
        <article class="stat-card tone-alarm">
          <span class="stat-label">报警测点</span>
          <strong class="stat-value">{{ monitor.alarmPointCount }}</strong>
        </article>
        <article class="stat-card tone-alarm">
          <span class="stat-label">报警监测对象</span>
          <strong class="stat-value">{{ monitor.alarmObjectCount }}</strong>
        </article>
      </div>
      <p class="link-note">
        「建筑监测」页读到的报警测点数也是 {{ monitor.alarmPointCount }} 个 /
        {{ monitor.alarmObjectCount }} 个对象，来源是同一份测点记录。
      </p>
    </section>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { getMonitoringSummary } from '@/api/monitor-service'
import type { MonitoringSummary, OverviewResult } from '@/data/types'
import { today } from '@/api/monitor-service'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const monitor = ref<MonitoringSummary>({
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

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  monitor.value = getMonitoringSummary()
}

onMounted(refresh)
</script>

<style scoped>
.link-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin: 4px 0 16px;
}
.link-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.link-head h3 { margin: 0; font-size: 15px; }
.link-asof { color: var(--muted); font-size: 12px; }
.link-note { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.tone-due { border-left: 3px solid #d97706; }
.tone-error { border-left: 3px solid #b42318; }
.tone-alarm { border-left: 3px solid #dc2626; }
</style>
