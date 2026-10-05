import type { MonitorAux, ScenarioSpec } from './types'

// 沉降监测域的扩展存储：读数明细、取数异常、测区事件、补测游标、演练场景。
// 与主表（shield-tunnel-construction:entries）分开存放，互不污染；
// 读不出来按内存种子兜底，写不进去原样抛错，由调用方把入参退回，不制造半条数据。
const AUX_KEY = 'shield-tunnel-construction:settlement-monitor:v1'

// 由 seed-monitor 注入：避免与种子文件产生循环依赖。
let seedFactory: () => MonitorAux = () => ({
  readings: [],
  failures: [],
  areaEvents: [],
  cursors: [],
  scenario: { kind: 'normal' },
  seq: 0,
})

export function registerMonitorSeed(factory: () => MonitorAux): void {
  seedFactory = factory
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: MonitorAux | null = null

export function readMonitorAux(): MonitorAux {
  if (cache) {
    return cache
  }
  const fallback = seedFactory()
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = fallback
    return cache
  }
  const raw = window.localStorage.getItem(AUX_KEY)
  if (!raw) {
    cache = fallback
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as MonitorAux
    cache = {
      readings: parsed.readings ?? [],
      failures: parsed.failures ?? [],
      areaEvents: parsed.areaEvents ?? [],
      cursors: parsed.cursors ?? [],
      scenario: (parsed.scenario as ScenarioSpec) ?? { kind: 'normal' },
      seq: parsed.seq ?? 0,
    }
    return cache
  } catch {
    // 扩展数据坏了不拖垮主表：退回内存种子，下一次保存自愈。
    cache = clone(fallback)
    return cache
  }
}

// 保存失败必须原样抛出：调用方负责把本次入参退还给页面，不能吞掉写失败。
export function writeMonitorAux(next: MonitorAux): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(AUX_KEY, JSON.stringify(next))
  }
}

export function resetMonitorAux(): MonitorAux {
  const fresh = clone(seedFactory())
  writeMonitorAux(fresh)
  return fresh
}
