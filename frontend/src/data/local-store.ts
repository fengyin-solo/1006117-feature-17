import { SEED_ROWS } from './seed'
import { buildMonitorSeed } from './seed-monitor'
import { registerMonitorSeed } from './monitor-store'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

registerMonitorSeed(buildMonitorSeed)

// 旧版播种过占位数据（「地表沉降样例1」这类），监测域改版后字段对不上，
// 命中就把这两个模块整体换成新种子，其余模块保持用户已有改动不动。
function migrateLegacy(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next = data
  const legacySettlement = (next.settlement ?? []).some(
    (row) => '监测日期' in row || String(row['测点位置'] ?? '').includes('样例'),
  )
  if (legacySettlement) {
    next.settlement = clone(SEED_ROWS.settlement)
    next.building = clone(SEED_ROWS.building)
  }
  return next
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return migrateLegacy({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
