import { SEED_BATCHES, SEED_READINGS, SEED_ROWS, SCHEMA_VERSION } from './seed'
import type { CollectBatchRow, EntryRow, ReadingRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const READINGS_KEY = 'shield-tunnel-construction:settlement-readings'
const BATCHES_KEY = 'shield-tunnel-construction:settlement-batches'
const VERSION_KEY = 'shield-tunnel-construction:schema-version'

// 台账结构升级后需要重建的模块：老缓存里的同名记录直接换成新台账，读数/批次另存。
const RESET_ON_UPGRADE = ['settlement', 'building']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function schemaOutdated(): boolean {
  if (!hasStorage()) {
    return false
  }
  return window.localStorage.getItem(VERSION_KEY) !== String(SCHEMA_VERSION)
}

function stampSchema(): void {
  if (hasStorage()) {
    window.localStorage.setItem(VERSION_KEY, String(SCHEMA_VERSION))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!hasStorage()) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    stampSchema()
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    if (schemaOutdated()) {
      // 结构升级：只重建受影响模块，其余模块保留浏览器里的改动。
      for (const key of RESET_ON_UPGRADE) {
        parsed[key] = clone(SEED_ROWS[key] ?? [])
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...fallback, ...parsed }))
      window.localStorage.removeItem(READINGS_KEY)
      window.localStorage.removeItem(BATCHES_KEY)
      stampSchema()
    }
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    stampSchema()
    return fallback
  }
}

function readSideStore<T>(key: string, fallback: T): T {
  if (!hasStorage()) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

function writeSideStore<T>(key: string, value: T): void {
  if (hasStorage()) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let cache: Record<string, EntryRow[]> | null = null
let readingsCache: ReadingRow[] | null = null
let batchesCache: CollectBatchRow[] | null = null

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
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function listReadings(): ReadingRow[] {
  if (readingsCache === null) {
    readingsCache = readSideStore(READINGS_KEY, SEED_READINGS)
  }
  return readingsCache
}

export function saveReadings(rows: ReadingRow[]): void {
  readingsCache = rows
  writeSideStore(READINGS_KEY, rows)
}

export function listBatches(): CollectBatchRow[] {
  if (batchesCache === null) {
    batchesCache = readSideStore(BATCHES_KEY, SEED_BATCHES)
  }
  return batchesCache
}

export function saveBatches(rows: CollectBatchRow[]): void {
  batchesCache = rows
  writeSideStore(BATCHES_KEY, rows)
}

export function resetSettlementStores(): void {
  resetRows('settlement')
  resetRows('building')
  readingsCache = clone(SEED_READINGS)
  batchesCache = clone(SEED_BATCHES)
  writeSideStore(READINGS_KEY, readingsCache)
  writeSideStore(BATCHES_KEY, batchesCache)
}

export function storageKey(): string {
  return STORAGE_KEY
}
