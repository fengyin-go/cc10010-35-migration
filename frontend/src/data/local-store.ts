import { readLegacySnapshot, seedLegacyStorage, writeLegacyModules } from './legacy-storage'
import { readRowsCache, seedFallbackRows, writeRowsCache } from './rows-cache'
import { isAuditVersionedActive, listAuditRows } from './audit-storage'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：其他模块仍用旧的无版本存储；审计日志迁移完成后由版本化存储接管。
const STORAGE_KEY = 'lake-govern-config:entries'

function readBase(): Record<string, EntryRow[]> {
  const fallback = seedFallbackRows()
  const snapshot = readLegacySnapshot()
  if (snapshot.kind === 'missing') {
    seedLegacyStorage()
    return fallback
  }
  if (snapshot.kind === 'corrupt') {
    // 不覆盖损坏的原文：留给审计迁移的隔离区保存原值，页面上先按示例数据显示。
    return fallback
  }
  const merged: Record<string, EntryRow[]> = { ...fallback }
  for (const [key, value] of Object.entries(snapshot.data)) {
    // 单个模块结构损坏时保留示例数据，不让坏值把整页渲染打挂。
    if (Array.isArray(value)) {
      merged[key] = value as EntryRow[]
    }
  }
  return merged
}

export function invalidateRowsCache(): void {
  writeRowsCache(null)
}

function withAuditOverlay(base: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (!isAuditVersionedActive()) {
    return base
  }
  return { ...base, audit: listAuditRows() }
}

export function allRows(): Record<string, EntryRow[]> {
  let cache = readRowsCache()
  if (cache === null) {
    cache = readBase()
    writeRowsCache(cache)
  }
  return withAuditOverlay(cache)
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function legacyBase(): Record<string, unknown> {
  const snapshot = readLegacySnapshot()
  if (snapshot.kind === 'ok') {
    return snapshot.data
  }
  if (snapshot.kind === 'missing') {
    return seedLegacyStorage()
  }
  throw new Error('旧存储内容损坏，暂不写入，避免覆盖原始内容')
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (key === 'audit' && isAuditVersionedActive()) {
    // 已切换到版本化存储后，旧存储不再作为数据源。
    invalidateRowsCache()
    return
  }
  const base = legacyBase()
  if (!writeLegacyModules(base, { [key]: rows })) {
    throw new Error('本地存储写入失败')
  }
  const cache = readRowsCache()
  if (cache !== null) {
    writeRowsCache({ ...cache, [key]: rows })
  }
}

export function resetRows(key: string): EntryRow[] {
  if (key === 'audit' && isAuditVersionedActive()) {
    // 已迁移的审计日志不能靠重置清掉；如需回滚请走专门的迁移回退流程。
    return listAuditRows()
  }
  const rows = JSON.parse(JSON.stringify(SEED_ROWS[key] ?? [])) as EntryRow[]
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
