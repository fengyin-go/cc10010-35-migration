import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, invalidateRowsCache, listRows, resetRows, saveRows } from '@/data/local-store'
import { AUDIT_MODULE_KEY, NEGATIVE_ACTIONS } from '@/data/audit-model'
import {
  buildAuditExport,
  createAuditRecord as createVersionedOrLegacyAudit,
  runAuditAction,
} from '@/data/audit-storage'
import type { AuditCreateInput, AuditCreateResult } from '@/data/audit-storage'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

export {
  auditCompatibilityReport,
  auditMigrationEnvironment,
  auditMigrationQueue,
  auditMigrationState,
  auditRecordDetail,
  auditStoreKey,
  buildAuditExport,
  enqueueAuditExport,
  listAuditExportQueue,
  processAuditExportQueue,
  retryAuditMigration,
  retryAuditMigrationBatch,
  runAuditMigration,
} from '@/data/audit-storage'
export type {
  AuditExportQueueItem,
  AuditMigrationEnvironment,
  AuditMigrationRunResult,
  AuditRecordDetail,
} from '@/data/audit-storage'
export type {
  AuditCompatibilityReport,
  AuditExportPayload,
  AuditMigrationQueueItem,
  AuditMigrationState,
} from '@/data/audit-model'
export type { AuditCreateInput, AuditCreateResult }

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === AUDIT_MODULE_KEY) {
    // 审计日志的动作按当前数据源分流：迁移期间走旧流程，迁移完成后走追加式版本结构。
    const result = runAuditAction(id, action)
    invalidateRowsCache()
    return result
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${meta.entity}写入本地存储失败`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  if (key === AUDIT_MODULE_KEY) {
    // 审计导出要覆盖新旧记录，并附带隔离记录的原值。
    const payload = buildAuditExport()
    return { filename: payload.filename, content: payload.content }
  }
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
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

export function registerAuditLog(input: AuditCreateInput): AuditCreateResult {
  const result = createVersionedOrLegacyAudit(input)
  if (result.ok) {
    invalidateRowsCache()
  }
  return result
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
