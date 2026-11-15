import { MODULE_BY_KEY } from './modules'
import type { EntryRow, ModuleMeta } from './types'

/** 审计日志版本化存储的常量与纯函数：不碰 localStorage，方便迁移、导出和测试复用。 */

export const AUDIT_MODULE_KEY = 'audit'
export const AUDIT_STORE_SCHEMA_VERSION = 2 as const
/** 升级后的追加式版本存储；和旧的无版本存储完全分开。 */
export const AUDIT_STORE_KEY = 'lake-govern-config:audit-store:v2'
/** 迁移完成前先把旧审计段原样备份，源数据被清理后仍可回填/追溯。 */
export const AUDIT_LEGACY_BACKUP_KEY = 'lake-govern-config:audit-legacy-backup:v1'
/** 跨模块审计导出队列。 */
export const AUDIT_EXPORT_QUEUE_KEY = 'lake-govern-config:audit-export-queue:v1'
export const DEFAULT_MIGRATION_BATCH_SIZE = 50

/** 与旧版 local-service 完全一致的负向动作判定，历史取值不重新解释。 */
export const NEGATIVE_ACTIONS = [
  '撤销',
  '作废',
  '拒绝',
  '驳回',
  '停用',
  '忽略',
  '下线',
  '回滚',
]

/** 旧存储行里属于流程控制、不进业务字段快照的键。 */
const FLOW_KEYS = new Set(['id', 'status', 'pending', 'abnormal'])

export type AuditScalar = string | number | boolean
export type AuditPayload = Record<string, AuditScalar>

export type AuditVersionKind = 'migrated' | 'created' | 'status-change'

/** 一条审计日志的一次完整快照；版本只追加，不覆盖。 */
export type AuditVersion = {
  version: number
  kind: AuditVersionKind
  recordedAt: string
  operationTime: string
  status: string
  pending: boolean
  abnormal: boolean
  payload: AuditPayload
}

/** 迁移后的审计日志：versions 从 1 开始只增不改，归档后不再追加。 */
export type AuditEntry = {
  id: number
  logId: string
  /** 旧存储里的数字编号；迁移记录保留下来，新增记录为 null。 */
  legacyId: number | null
  /** 在旧审计数组中的原始下标，用做迁移幂等键。 */
  sourceIndex: number | null
  origin: 'legacy' | 'native'
  operationTime: string
  archived: boolean
  archivedAt: string | null
  versions: AuditVersion[]
}

export type AuditMigrationStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed'

export type AuditMigrationBatch = {
  batchId: string
  from: number
  to: number
  status: 'success' | 'failed'
  attempts: number
  imported: number
  skipped: number
  quarantined: number
  entryIds: number[]
  startedAt: string
  finishedAt: string | null
  error: string | null
}

export type AuditQuarantineRecord = {
  id: string
  sourceKind: 'legacy-audit' | 'legacy-store'
  sourceIndex: number
  reason: string
  /** 原值：能解析成 JSON 的保留结构，整段损坏的保留原始字符串。 */
  raw: unknown
  /** 原始文本，导出时原样输出。 */
  rawText: string
  checksum: string
  quarantinedAt: string
}

export type AuditCompatibilityReport = {
  storageVersion: 1 | 2
  legacySchema: 'unversioned'
  activeSource: 'legacy' | 'versioned'
  status: AuditMigrationStatus
  totalLegacy: number
  migrated: number
  quarantined: number
  pending: number
  archivedPreserved: number
  fieldsPreserved: string[]
  oldFlowReadable: boolean
  completeExport: boolean
  notes: string[]
  updatedAt: string
}

export type AuditMigrationState = {
  status: AuditMigrationStatus
  cursor: number
  total: number
  batchSize: number
  batches: AuditMigrationBatch[]
  sourceKind: 'legacy' | 'backup' | 'none'
  legacyRawChecksum: string | null
  backupWritten: boolean
  legacyRetired: boolean
  error: string | null
  startedAt: string | null
  updatedAt: string
  completedAt: string | null
}

/** 版本化存储在 localStorage 中的完整结构；active 是唯一的“当前数据源”开关。 */
export type AuditStore = {
  schemaVersion: typeof AUDIT_STORE_SCHEMA_VERSION
  active: boolean
  entries: AuditEntry[]
  nextId: number
  migration: AuditMigrationState
  quarantine: AuditQuarantineRecord[]
  compatibility: AuditCompatibilityReport | null
  createdAt: string
  updatedAt: string
}

export type AuditMigrationQueueItem = {
  sourceIndex: number
  sourceId: number | null
  logId: string | null
  status: 'pending' | 'migrated' | 'quarantined' | 'failed'
  reason: string | null
  batchId: string | null
  entryId: number | null
  operationTime: string
}

export type AuditExportRow = {
  row: EntryRow
  origin: 'legacy' | 'native'
  version: number
  archived: boolean
  sourceIndex: number | null
}

export type AuditExportPayload = {
  source: 'legacy' | 'versioned'
  sourceVersion: 1 | 2
  rows: AuditExportRow[]
  quarantined: AuditQuarantineRecord[]
  filename: string
  content: string
}

export function auditMeta(): ModuleMeta {
  const meta = MODULE_BY_KEY.get(AUDIT_MODULE_KEY)
  if (!meta) {
    throw new Error('没有登记操作审计模块')
  }
  return meta
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** FNV-1a：用来给隔离记录/旧存储快照做稳定指纹，避免重复迁移时重复隔离。 */
export function checksumText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash >>>= 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function isScalar(value: unknown): value is AuditScalar {
  return (
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  )
}

export type LegacyAuditRowResult =
  | {
      ok: true
      id: number
      logId: string
      operationTime: string
      status: string
      pending: boolean
      abnormal: boolean
      archived: boolean
      payload: AuditPayload
    }
  | { ok: false; reason: string }

/**
 * 校验一条旧审计记录。能还原的字段按原值进入快照；结构损坏的（不是对象、
 * 缺编号/时间、字段不是标量）返回原因，由调用方隔离并保留原值。
 */
export function validateLegacyAuditRow(row: unknown, index: number): LegacyAuditRowResult {
  if (!isPlainObject(row)) {
    return { ok: false, reason: `第 ${index + 1} 条记录不是对象` }
  }
  const rawId = row.id
  const id =
    typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && rawId.trim() !== ''
        ? Number(rawId)
        : Number.NaN
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, reason: `第 ${index + 1} 条记录缺少合法的数字编号` }
  }

  const rawLogId = row['日志编号']
  if (!isScalar(rawLogId) || String(rawLogId).trim() === '') {
    return { ok: false, reason: `第 ${index + 1} 条记录缺少日志编号` }
  }

  const rawTime = row['执行时间']
  if (!isScalar(rawTime) || String(rawTime).trim() === '') {
    return { ok: false, reason: `第 ${index + 1} 条记录缺少操作时间` }
  }
  const operationTime = String(rawTime).trim()
  if (Number.isNaN(Date.parse(operationTime))) {
    return { ok: false, reason: `第 ${index + 1} 条记录的操作时间无法解析` }
  }

  if (typeof row.status !== 'string' || row.status.trim() === '') {
    return { ok: false, reason: `第 ${index + 1} 条记录缺少状态` }
  }
  const status = row.status

  const payload: AuditPayload = {}
  for (const field of auditMeta().fields) {
    payload[field] = ''
  }
  for (const [key, value] of Object.entries(row)) {
    if (FLOW_KEYS.has(key)) {
      continue
    }
    if (!isScalar(value)) {
      return { ok: false, reason: `第 ${index + 1} 条记录的字段「${key}」不是标量` }
    }
    payload[key] = value
  }

  const lastStatus = auditMeta().statuses[auditMeta().statuses.length - 1]
  return {
    ok: true,
    id,
    logId: String(rawLogId),
    operationTime,
    status,
    // 历史取值沿用旧规则：旧行里已有的布尔值原样保留，缺省才按状态推导。
    pending: typeof row.pending === 'boolean' ? row.pending : status !== lastStatus,
    abnormal: typeof row.abnormal === 'boolean' ? row.abnormal : false,
    archived: status === '已归档',
    payload,
  }
}

export function latestAuditVersion(entry: AuditEntry): AuditVersion {
  const latest = entry.versions[entry.versions.length - 1]
  if (!latest) {
    throw new Error(`审计日志 ${entry.logId} 没有版本记录`)
  }
  return latest
}

export function auditEntryToRow(entry: AuditEntry): EntryRow {
  const latest = latestAuditVersion(entry)
  return {
    ...latest.payload,
    id: entry.id,
    status: latest.status,
    pending: latest.pending,
    abnormal: latest.abnormal,
  }
}

export function compareAuditEntries(left: AuditEntry, right: AuditEntry): number {
  const leftTime = Date.parse(left.operationTime)
  const rightTime = Date.parse(right.operationTime)
  if (leftTime !== rightTime) {
    return leftTime - rightTime
  }
  const leftSeed = left.legacyId ?? left.id
  const rightSeed = right.legacyId ?? right.id
  if (leftSeed !== rightSeed) {
    return leftSeed - rightSeed
  }
  return left.logId.localeCompare(right.logId)
}

export function sortAuditEntries(entries: AuditEntry[]): AuditEntry[] {
  return [...entries].sort(compareAuditEntries)
}

export function nextAuditLogId(existing: Iterable<string>): string {
  let max = 0
  for (const logId of existing) {
    const matched = /(\d+)\s*$/.exec(logId)
    if (matched) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `AUDI-${String(max + 1).padStart(4, '0')}`
}

export function nextAuditNumericId(entries: AuditEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}
