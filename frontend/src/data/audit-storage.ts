import pkg from '../../package.json'

import {
  AUDIT_EXPORT_QUEUE_KEY,
  AUDIT_LEGACY_BACKUP_KEY,
  AUDIT_MODULE_KEY,
  AUDIT_STORE_KEY,
  AUDIT_STORE_SCHEMA_VERSION,
  DEFAULT_MIGRATION_BATCH_SIZE,
  NEGATIVE_ACTIONS,
  auditEntryToRow,
  auditMeta,
  checksumText,
  clone,
  compareAuditEntries,
  csvLine,
  isPlainObject,
  isScalar,
  latestAuditVersion,
  nextAuditLogId,
  nextAuditNumericId,
  nowIso,
  sortAuditEntries,
  validateLegacyAuditRow,
} from './audit-model'
import type {
  AuditCompatibilityReport,
  AuditEntry,
  AuditExportPayload,
  AuditExportRow,
  AuditMigrationBatch,
  AuditMigrationQueueItem,
  AuditMigrationState,
  AuditMigrationStatus,
  AuditPayload,
  AuditQuarantineRecord,
  AuditStore,
  AuditVersion,
} from './audit-model'
import {
  clone as cloneLegacy,
  hasLocalStorage,
  readLegacySnapshot,
  seedLegacyStorage,
  writeLegacyBlob,
  writeLegacyModules,
} from './legacy-storage'
import { writeRowsCache } from './rows-cache'
import { SEED_ROWS } from './seed'
import type { ActionResult, EntryRow } from './types'

/**
 * 审计日志的版本化存储与迁移。
 *
 * 数据源切换只有一个开关：AuditStore.active。
 * - active=false：读取、写入、导出全部走旧的无版本存储（迁移期间保持原有流程）。
 * - active=true：只认版本化存储，旧存储里的审计段在切换后被清空，不会再被读。
 *
 * 另外版本化存储里的 entries 是追加式的：状态变化只追加新版本，已归档日志冻结。
 */

const memoryStorage = new Map<string, string>()

// 没有 localStorage 时（Node 测试、SSR）退化成进程内存储，读到的仍然是同一份键值。
function getItem(key: string): string | null {
  if (hasLocalStorage()) {
    return window.localStorage.getItem(key)
  }
  return memoryStorage.get(key) ?? null
}

function setItem(key: string, value: string): void {
  if (hasLocalStorage()) {
    window.localStorage.setItem(key, value)
    return
  }
  memoryStorage.set(key, value)
}

function removeItem(key: string): void {
  if (hasLocalStorage()) {
    window.localStorage.removeItem(key)
    return
  }
  memoryStorage.delete(key)
}

export function auditStoreKey(): string {
  return AUDIT_STORE_KEY
}

function readVersionedStore(): AuditStore | null {
  const raw = getItem(AUDIT_STORE_KEY)
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isPlainObject(parsed) || parsed.schemaVersion !== AUDIT_STORE_SCHEMA_VERSION) {
      return null
    }
    if (!Array.isArray(parsed.entries) || !isPlainObject(parsed.migration)) {
      return null
    }
    return parsed as unknown as AuditStore
  } catch {
    return null
  }
}

function writeVersionedStore(store: AuditStore): void {
  store.updatedAt = nowIso()
  setItem(AUDIT_STORE_KEY, JSON.stringify(store))
}

export type LegacyAuditSource = {
  kind: 'legacy' | 'backup' | 'seed' | 'none'
  rows: unknown[]
  rootRaw: string | null
  rootError: string | null
  segmentRaw: string | null
  segmentError: string | null
  checksum: string | null
  usedSeedFallback: boolean
}

type LegacyBackup = {
  schemaVersion: 1
  capturedAt: string
  checksum: string
  audit: unknown[]
  raw: string | null
}

function readBackup(): LegacyBackup | null {
  const raw = getItem(AUDIT_LEGACY_BACKUP_KEY)
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isPlainObject(parsed) || !Array.isArray(parsed.audit)) {
      return null
    }
    return parsed as unknown as LegacyBackup
  } catch {
    return null
  }
}

function seedAuditRows(): unknown[] {
  return cloneLegacy(SEED_ROWS[AUDIT_MODULE_KEY] ?? []) as unknown[]
}

/**
 * 读取旧存储里的审计段。任何无法解析的内容都不覆写，只把原文带出来交给隔离区。
 * 解析失败时的取值规则和升级前保持一致：回落到示例数据。
 */
export function readLegacyAuditSource(): LegacyAuditSource {
  const snapshot = readLegacySnapshot()
  if (snapshot.kind === 'missing') {
    const rows = seedAuditRows()
    return {
      kind: 'seed',
      rows,
      rootRaw: null,
      rootError: null,
      segmentRaw: null,
      segmentError: null,
      checksum: checksumText(JSON.stringify(rows)),
      usedSeedFallback: true,
    }
  }

  if (snapshot.kind === 'corrupt') {
    const backup = readBackup()
    const rows = backup ? cloneLegacy(backup.audit) : seedAuditRows()
    return {
      kind: backup ? 'backup' : 'seed',
      rows,
      rootRaw: snapshot.raw,
      rootError: snapshot.error,
      segmentRaw: null,
      segmentError: null,
      checksum: checksumText(JSON.stringify(rows)),
      usedSeedFallback: !backup,
    }
  }

  const auditValue = snapshot.data[AUDIT_MODULE_KEY]
  if (auditValue === undefined) {
    const rows = seedAuditRows()
    return {
      kind: 'seed',
      rows,
      rootRaw: null,
      rootError: null,
      segmentRaw: null,
      segmentError: null,
      checksum: checksumText(JSON.stringify(rows)),
      usedSeedFallback: true,
    }
  }

  if (!Array.isArray(auditValue)) {
    const backup = readBackup()
    const segmentRaw = JSON.stringify(auditValue)
    const rows = backup ? cloneLegacy(backup.audit) : []
    return {
      kind: backup ? 'backup' : 'legacy',
      rows,
      rootRaw: null,
      rootError: null,
      segmentRaw,
      segmentError: '旧存储里的审计日志不是数组',
      checksum: checksumText(JSON.stringify(rows)),
      usedSeedFallback: false,
    }
  }

  return {
    kind: 'legacy',
    rows: auditValue,
    rootRaw: null,
    rootError: null,
    segmentRaw: null,
    segmentError: null,
    checksum: checksumText(JSON.stringify(auditValue)),
    usedSeedFallback: false,
  }
}

export function isAuditVersionedActive(): boolean {
  return readVersionedStore()?.active === true
}

function emptyMigrationState(source: LegacyAuditSource): AuditMigrationState {
  const now = nowIso()
  return {
    status: 'pending',
    cursor: 0,
    total: source.rows.length,
    batchSize: DEFAULT_MIGRATION_BATCH_SIZE,
    batches: [],
    sourceKind: source.kind === 'seed' || source.kind === 'none' ? 'none' : source.kind,
    legacyRawChecksum: source.checksum,
    backupWritten: false,
    legacyRetired: false,
    error: null,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
  }
}

function createStore(source: LegacyAuditSource): AuditStore {
  const now = nowIso()
  return {
    schemaVersion: AUDIT_STORE_SCHEMA_VERSION,
    active: false,
    entries: [],
    nextId: 1,
    migration: emptyMigrationState(source),
    quarantine: [],
    compatibility: null,
    createdAt: now,
    updatedAt: now,
  }
}

function ensureStore(): AuditStore {
  const existing = readVersionedStore()
  if (existing) {
    return existing
  }
  const store = createStore(readLegacyAuditSource())
  store.compatibility = buildCompatibilityReport(store)
  writeVersionedStore(store)
  return store
}

export type AuditMigrationEnvironment = {
  storageVersion: 1 | 2
  storageKey: string
  legacySchema: 'unversioned'
  environment: {
    mode: string
    appName: string
    apiBase: string
    dev: boolean
  }
  buildDependencies: {
    package: string
    version: string
    react: string
    vite: string
    typescript: string
  }
}

export function auditMigrationEnvironment(): AuditMigrationEnvironment {
  const env = import.meta.env ?? {}
  const dependencies = pkg.dependencies ?? {}
  const devDependencies = pkg.devDependencies ?? {}
  return {
    storageVersion: isAuditVersionedActive() ? 2 : 1,
    storageKey: AUDIT_STORE_KEY,
    legacySchema: 'unversioned',
    environment: {
      mode: env.MODE ?? 'unknown',
      appName: env.VITE_APP_NAME ?? pkg.name,
      apiBase: env.VITE_API_BASE ?? '',
      dev: env.DEV ?? false,
    },
    buildDependencies: {
      package: pkg.name,
      version: pkg.version,
      react: dependencies.react ?? 'unknown',
      vite: devDependencies.vite ?? 'unknown',
      typescript: devDependencies.typescript ?? 'unknown',
    },
  }
}

function migrationNotes(store: AuditStore, source: LegacyAuditSource): string[] {
  const env = auditMigrationEnvironment()
  const notes = [
    `存储版本：v${store.active ? 2 : 1}（旧结构无版本标记，schema=unversioned）`,
    `storageVersion/环境/构建流水线依赖均在读取时按当前存储版本解析，不写死`,
    `运行环境：${env.environment.mode}${env.environment.dev ? ' (development)' : ''}`,
    `构建依赖：${env.buildDependencies.package}@${env.buildDependencies.version} / react@${env.buildDependencies.react} / vite@${env.buildDependencies.vite} / typescript@${env.buildDependencies.typescript}`,
    `迁移数据源：${source.kind}，批次大小 ${store.migration.batchSize}`,
    '历史取值沿用旧规则：pending/abnormal 按旧字段原样保留，缺失时才按状态推导',
    store.active
      ? '旧存储的审计段已在切换前备份，并置空，不再作为数据源'
      : '迁移未完成前，列表、动作与导出仍读旧存储，保持原有流程',
  ]
  if (source.rootError) {
    notes.push(`旧存储整体无法解析，原始内容已进入隔离区：${source.rootError}`)
  }
  if (source.segmentError) {
    notes.push(`旧存储审计段无法解析，原始内容已进入隔离区：${source.segmentError}`)
  }
  if (source.usedSeedFallback && !store.active) {
    notes.push('旧存储缺少可读审计数据，按升级前规则回落到本地示例数据')
  }
  return notes
}

function quarantineCount(store: AuditStore): number {
  return store.quarantine.length
}

export function buildCompatibilityReport(store: AuditStore | null): AuditCompatibilityReport {
  const source = readLegacyAuditSource()
  const active = store?.active === true
  const migration = store?.migration
  const totalLegacy = migration ? migration.total : source.rows.length
  const migrated = store
    ? store.entries.filter((entry) => entry.origin === 'legacy').length
    : 0
  const quarantined = store ? quarantineCount(store) : 0
  const status: AuditMigrationStatus = active
    ? 'completed'
    : (migration?.status ?? 'pending')
  return {
    storageVersion: active ? 2 : 1,
    legacySchema: 'unversioned',
    activeSource: active ? 'versioned' : 'legacy',
    status,
    totalLegacy,
    migrated,
    quarantined,
    pending: active ? 0 : Math.max(0, totalLegacy - (migration?.cursor ?? 0)),
    archivedPreserved: store
      ? store.entries.filter((entry) => entry.origin === 'legacy' && entry.archived).length
      : 0,
    fieldsPreserved: auditMeta().fields,
    oldFlowReadable: source.rootError === null,
    completeExport: true,
    notes: store ? migrationNotes(store, source) : migrationNotes(createStore(source), source),
    updatedAt: nowIso(),
  }
}

export function auditCompatibilityReport(): AuditCompatibilityReport {
  return buildCompatibilityReport(readVersionedStore())
}

export function auditMigrationState(): AuditMigrationState | null {
  const store = readVersionedStore()
  return store ? clone(store.migration) : null
}

function pushQuarantine(
  store: AuditStore,
  record: Omit<AuditQuarantineRecord, 'id' | 'checksum' | 'quarantinedAt'>,
): void {
  const checksum = checksumText(record.rawText)
  const exists = store.quarantine.some(
    (item) =>
      item.sourceKind === record.sourceKind &&
      item.sourceIndex === record.sourceIndex &&
      item.checksum === checksum,
  )
  if (exists) {
    return
  }
  store.quarantine.push({
    ...record,
    id: `q-${store.quarantine.length + 1}-${checksum}`,
    checksum,
    quarantinedAt: nowIso(),
  })
}

function quarantineRootIfNeeded(store: AuditStore, source: LegacyAuditSource): void {
  if (source.rootRaw !== null && source.rootError) {
    pushQuarantine(store, {
      sourceKind: 'legacy-store',
      sourceIndex: -1,
      reason: `旧存储整体无法解析：${source.rootError}`,
      raw: source.rootRaw,
      rawText: source.rootRaw,
    })
  }
  if (source.segmentRaw !== null && source.segmentError) {
    pushQuarantine(store, {
      sourceKind: 'legacy-audit',
      sourceIndex: -1,
      reason: `旧存储审计段无法解析：${source.segmentError}`,
      raw: source.segmentRaw,
      rawText: source.segmentRaw,
    })
  }
}

function existingSourceIndexes(store: AuditStore): Map<number, AuditEntry> {
  const map = new Map<number, AuditEntry>()
  for (const entry of store.entries) {
    if (entry.origin === 'legacy' && entry.sourceIndex !== null) {
      map.set(entry.sourceIndex, entry)
    }
  }
  return map
}

function existingLogIds(store: AuditStore): Set<string> {
  return new Set(store.entries.map((entry) => entry.logId))
}

function buildMigratedEntry(
  validation: Extract<ReturnType<typeof validateLegacyAuditRow>, { ok: true }>,
  index: number,
  id: number,
): AuditEntry {
  const recordedAt = nowIso()
  const version: AuditVersion = {
    version: 1,
    kind: 'migrated',
    recordedAt,
    operationTime: validation.operationTime,
    status: validation.status,
    pending: validation.pending,
    abnormal: validation.abnormal,
    payload: clone(validation.payload),
  }
  return {
    id,
    logId: validation.logId,
    legacyId: validation.id,
    sourceIndex: index,
    origin: 'legacy',
    operationTime: validation.operationTime,
    archived: validation.archived,
    archivedAt: validation.archived ? recordedAt : null,
    versions: [version],
  }
}

function writeBackup(source: LegacyAuditSource, checksum: string): boolean {
  const backup: LegacyBackup = {
    schemaVersion: 1,
    capturedAt: nowIso(),
    checksum,
    audit: cloneLegacy(source.rows),
    raw: source.rootRaw,
  }
  try {
    setItem(AUDIT_LEGACY_BACKUP_KEY, JSON.stringify(backup))
    return true
  } catch {
    return false
  }
}

function clearLegacyAuditSegment(): boolean {
  const snapshot = readLegacySnapshot()
  if (snapshot.kind === 'missing') {
    // 首次使用就走迁移：把其余模块的示例数据落到旧存储，审计段留空，保持单一数据源。
    const seed = cloneLegacy(SEED_ROWS) as Record<string, unknown>
    seed[AUDIT_MODULE_KEY] = []
    return writeLegacyBlob(seed)
  }
  if (snapshot.kind === 'corrupt') {
    // 损坏的原文必须保留，不覆写；它已经不是当前数据源。
    return false
  }
  return writeLegacyModules(snapshot.data, { [AUDIT_MODULE_KEY]: [] })
}

export type AuditMigrationRunResult = {
  ok: boolean
  status: AuditMigrationStatus
  message: string
  cursor: number
  total: number
  migrated: number
  quarantined: number
  active: boolean
}

export type AuditMigrationOptions = {
  batchSize?: number
  /** 只跑 N 个批次就返回，用来模拟中断并从最后成功批次续跑。 */
  maxBatches?: number
  /** 从第 0 条重新跑；已迁移的记录按来源下标和日志编号幂等跳过。 */
  restart?: boolean
}

function finishRun(
  store: AuditStore,
  message: string,
  ok = true,
): AuditMigrationRunResult {
  store.compatibility = buildCompatibilityReport(store)
  try {
    writeVersionedStore(store)
  } catch {
    // 报告写不进去也不影响动作结果；下一次成功写入会补上。
  }
  return {
    ok,
    status: store.migration.status,
    message,
    cursor: store.migration.cursor,
    total: store.migration.total,
    migrated: store.entries.filter((entry) => entry.origin === 'legacy').length,
    quarantined: quarantineCount(store),
    active: store.active,
  }
}

export function runAuditMigration(
  options: AuditMigrationOptions = {},
): AuditMigrationRunResult {
  const store = ensureStore()
  if (store.active) {
    return finishRun(store, '审计日志已迁移到版本化存储，无需重复迁移')
  }

  const source = readLegacyAuditSource()
  store.migration.sourceKind =
    source.kind === 'seed' || source.kind === 'none' ? 'none' : source.kind
  store.migration.legacyRawChecksum = source.checksum
  store.migration.total = source.rows.length
  store.migration.batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? store.migration.batchSize ?? DEFAULT_MIGRATION_BATCH_SIZE),
  )
  quarantineRootIfNeeded(store, source)

  if (options.restart) {
    store.migration.cursor = 0
  }
  if (store.migration.cursor > source.rows.length) {
    store.migration.cursor = source.rows.length
  }

  store.migration.status = 'running'
  store.migration.error = null
  store.migration.startedAt = store.migration.startedAt ?? nowIso()
  store.migration.updatedAt = nowIso()
  writeVersionedStore(store)

  const batchLimit = options.maxBatches ?? Number.POSITIVE_INFINITY
  let batchesRun = 0

  while (store.migration.cursor < source.rows.length && batchesRun < batchLimit) {
    const from = store.migration.cursor
    const to = Math.min(source.rows.length, from + store.migration.batchSize)
    // 重试会移除旧批次，编号按已存在的最大序号递增，避免和后续批次重名。
    const nextBatchNumber =
      store.migration.batches.reduce((max, batch) => {
        const matched = /batch-(\d+)/.exec(batch.batchId)
        return matched ? Math.max(max, Number(matched[1])) : max
      }, 0) + 1
    const batchId = `batch-${String(nextBatchNumber).padStart(3, '0')}`
    const batch: AuditMigrationBatch = {
      batchId,
      from,
      to,
      status: 'success',
      attempts: 1,
      imported: 0,
      skipped: 0,
      quarantined: 0,
      entryIds: [],
      startedAt: nowIso(),
      finishedAt: null,
      error: null,
    }

    try {
      const byIndex = existingSourceIndexes(store)
      const logIds = existingLogIds(store)
      const usedIds = new Set(store.entries.map((item) => item.id))
      let nextFreeId = store.nextId
      while (usedIds.has(nextFreeId)) {
        nextFreeId += 1
      }
      for (let index = from; index < to; index += 1) {
        const existing = byIndex.get(index)
        if (existing) {
          batch.skipped += 1
          batch.entryIds.push(existing.id)
          continue
        }
        const validation = validateLegacyAuditRow(source.rows[index], index)
        if (!validation.ok) {
          batch.quarantined += 1
          pushQuarantine(store, {
            sourceKind: 'legacy-audit',
            sourceIndex: index,
            reason: validation.reason,
            raw: source.rows[index],
            rawText: JSON.stringify(source.rows[index]),
          })
          continue
        }
        if (logIds.has(validation.logId)) {
          batch.quarantined += 1
          pushQuarantine(store, {
            sourceKind: 'legacy-audit',
            sourceIndex: index,
            reason: `第 ${index + 1} 条记录的日志编号「${validation.logId}」重复，未导入`,
            raw: source.rows[index],
            rawText: JSON.stringify(source.rows[index]),
          })
          continue
        }
        // 尽量沿用旧数字编号，保持历史清单里的「编号」可对照；被占用或重复时才分配新号。
        let id = validation.id
        if (usedIds.has(id)) {
          while (usedIds.has(nextFreeId)) {
            nextFreeId += 1
          }
          id = nextFreeId
        }
        usedIds.add(id)
        const entry = buildMigratedEntry(validation, index, id)
        store.nextId = Math.max(store.nextId, id + 1)
        nextFreeId = Math.max(nextFreeId, store.nextId)
        store.entries.push(entry)
        logIds.add(entry.logId)
        batch.imported += 1
        batch.entryIds.push(entry.id)
      }
      batch.finishedAt = nowIso()
      store.migration.batches.push(batch)
      store.migration.cursor = to
      store.migration.updatedAt = nowIso()
      store.compatibility = buildCompatibilityReport(store)
      writeVersionedStore(store)
    } catch (error) {
      const message = error instanceof Error ? error.message : '迁移批次执行失败'
      batch.status = 'failed'
      batch.error = message
      batch.finishedAt = nowIso()
      store.migration.batches.push(batch)
      store.migration.status = 'failed'
      store.migration.error = message
      store.migration.updatedAt = nowIso()
      try {
        writeVersionedStore(store)
      } catch {
        // 持久化也失败时只能把错误抛回去，游标仍停在最后一个成功批次。
      }
      return finishRun(store, `批次 ${batchId} 失败：${message}`, false)
    }
    batchesRun += 1
  }

  if (store.migration.cursor < source.rows.length) {
    // 中断时只记录到最后一个成功批次；旧存储仍是当前数据源。
    store.migration.status = 'blocked'
    store.migration.updatedAt = nowIso()
    writeVersionedStore(store)
    return finishRun(
      store,
      `迁移已暂停，等待从第 ${store.migration.cursor + 1} 条继续`,
    )
  }

  // 所有批次成功：先备份，再原子切换 active，最后清空旧审计段。
  if (!store.migration.backupWritten) {
    const backupOk = writeBackup(source, store.migration.legacyRawChecksum ?? source.checksum ?? '')
    if (!backupOk) {
      store.migration.status = 'failed'
      store.migration.error = '旧审计日志备份失败，未切换到新结构'
      store.migration.updatedAt = nowIso()
      writeVersionedStore(store)
      return finishRun(store, store.migration.error, false)
    }
    store.migration.backupWritten = true
  }

  store.active = true
  store.migration.status = 'completed'
  store.migration.completedAt = nowIso()
  store.migration.updatedAt = nowIso()
  store.migration.error = null
  store.compatibility = buildCompatibilityReport(store)
  // 唯一的数据源开关在这里落地；即使后面清理旧段失败，旧存储也不会再被读取。
  writeVersionedStore(store)

  // 备份已在切换前就绪；清理旧段失败时旧存储仍不会再成为当前数据源。
  const retired = clearLegacyAuditSegment()
  store.migration.legacyRetired = store.migration.legacyRetired || retired
  store.compatibility = buildCompatibilityReport(store)
  writeVersionedStore(store)

  return finishRun(
    store,
    store.migration.legacyRetired
      ? '迁移完成，已切换到版本化存储，旧审计段已备份并清空'
      : '迁移完成，已切换到版本化存储；旧存储损坏或缺失，原文保留在隔离区/备份中',
  )
}

export function retryAuditMigrationBatch(batchId?: string): AuditMigrationRunResult {
  const store = ensureStore()
  if (store.active) {
    return finishRun(store, '审计日志已完成迁移，没有需要重试的批次')
  }
  const target = batchId
    ? store.migration.batches.find((batch) => batch.batchId === batchId)
    : store.migration.batches.find((batch) => batch.status === 'failed')
  if (!target) {
    return finishRun(store, batchId ? `没有找到批次 ${batchId}` : '没有失败的迁移批次', false)
  }
  // 回填重试：只重跑这一个批次区间，已导入的记录按来源下标幂等跳过。
  store.migration.batches = store.migration.batches.filter(
    (batch) => batch.batchId !== target.batchId,
  )
  store.migration.cursor = Math.min(store.migration.cursor, target.from)
  store.migration.status = 'running'
  store.migration.error = null
  writeVersionedStore(store)
  return runAuditMigration({ maxBatches: 1, restart: false })
}

export function retryAuditMigration(): AuditMigrationRunResult {
  const store = ensureStore()
  const failed = store.migration.batches.filter((batch) => batch.status === 'failed')
  if (failed.length === 0) {
    // 没有失败批次时重试等价于继续跑：从最后成功批次的下一条继续。
    return runAuditMigration()
  }
  // 回填重试：回退到最早失败批次，已导入的记录按来源下标跳过，不会产生副本。
  store.migration.batches = store.migration.batches.filter((batch) => batch.status !== 'failed')
  store.migration.cursor = Math.min(...failed.map((batch) => batch.from))
  store.migration.status = 'running'
  store.migration.error = null
  writeVersionedStore(store)
  return runAuditMigration()
}

export function auditMigrationQueue(): AuditMigrationQueueItem[] {
  const store = readVersionedStore()
  const items: AuditMigrationQueueItem[] = []

  if (store?.active) {
    const batchByEntry = new Map<number, string>()
    for (const batch of store.migration.batches) {
      for (const entryId of batch.entryIds) {
        batchByEntry.set(entryId, batch.batchId)
      }
    }
    for (const entry of store.entries) {
      if (entry.origin !== 'legacy') {
        continue
      }
      items.push({
        sourceIndex: entry.sourceIndex ?? -1,
        sourceId: entry.legacyId,
        logId: entry.logId,
        status: 'migrated',
        reason: null,
        batchId: batchByEntry.get(entry.id) ?? null,
        entryId: entry.id,
        operationTime: entry.operationTime,
      })
    }
  } else {
    const source = readLegacyAuditSource()
    const scratch = store ?? createStore(source)
    const entriesByIndex = existingSourceIndexes(scratch)
    const quarantineByIndex = new Map<number, AuditQuarantineRecord>()
    for (const record of store?.quarantine ?? []) {
      if (record.sourceKind === 'legacy-audit' && record.sourceIndex >= 0) {
        quarantineByIndex.set(record.sourceIndex, record)
      }
    }
    const batchByEntry = new Map<number, string>()
    for (const batch of store?.migration.batches ?? []) {
      for (const entryId of batch.entryIds) {
        batchByEntry.set(entryId, batch.batchId)
      }
    }
    source.rows.forEach((raw, index) => {
      const entry = entriesByIndex.get(index) ?? null
      const quarantined = quarantineByIndex.get(index) ?? null
      let logId: string | null = null
      let sourceId: number | null = null
      let operationTime = ''
      if (isPlainObject(raw)) {
        if (isScalar(raw['日志编号'])) {
          logId = String(raw['日志编号'])
        }
        if (isScalar(raw.id)) {
          const numeric = Number(raw.id)
          sourceId = Number.isFinite(numeric) ? numeric : null
        }
        if (isScalar(raw['执行时间'])) {
          operationTime = String(raw['执行时间'])
        }
      }
      const batchId = entry ? batchByEntry.get(entry.id) ?? null : null
      const status: AuditMigrationQueueItem['status'] = entry
        ? 'migrated'
        : quarantined
          ? 'quarantined'
          : 'pending'
      items.push({
        sourceIndex: index,
        sourceId,
        logId,
        status,
        reason: quarantined?.reason ?? null,
        batchId,
        entryId: entry?.id ?? null,
        operationTime,
      })
    })
  }

  return items.sort((left, right) => {
    const leftTime = Date.parse(left.operationTime)
    const rightTime = Date.parse(right.operationTime)
    if (leftTime !== rightTime && !Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      return leftTime - rightTime
    }
    return left.sourceIndex - right.sourceIndex
  })
}

function legacyRowFromRaw(raw: unknown): EntryRow | null {
  if (!isPlainObject(raw)) {
    return null
  }
  const numericId = Number(raw.id)
  if (!Number.isFinite(numericId)) {
    return null
  }
  const row: EntryRow = {
    id: numericId,
    status: typeof raw.status === 'string' ? raw.status : '草稿',
    pending: false,
    abnormal: false,
  }
  for (const [key, value] of Object.entries(raw)) {
    if (isScalar(value)) {
      row[key] = value
    }
  }
  row.id = numericId
  row.status = typeof raw.status === 'string' ? raw.status : '草稿'
  const lastStatus = auditMeta().statuses[auditMeta().statuses.length - 1]
  row.pending = typeof raw.pending === 'boolean' ? raw.pending : row.status !== lastStatus
  row.abnormal = typeof raw.abnormal === 'boolean' ? raw.abnormal : false
  return row
}

function sortRowsByOperationTime(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort((left, right) => {
    const leftTime = Date.parse(String(left['执行时间'] ?? ''))
    const rightTime = Date.parse(String(right['执行时间'] ?? ''))
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime
    }
    return Number(left.id) - Number(right.id)
  })
}

/** 当前数据源下的审计行。active 时只读版本化存储，否则只读旧存储。 */
export function listAuditRows(): EntryRow[] {
  const store = readVersionedStore()
  if (store?.active) {
    return sortAuditEntries(store.entries).map(auditEntryToRow)
  }
  const source = readLegacyAuditSource()
  const rows: EntryRow[] = []
  for (const raw of source.rows) {
    const row = legacyRowFromRaw(raw)
    if (row) {
      rows.push(row)
    }
  }
  return sortRowsByOperationTime(rows)
}

export function getAuditStoreSnapshot(): AuditStore | null {
  return readVersionedStore()
}

function appendVersion(
  entry: AuditEntry,
  kind: AuditVersion['kind'],
  status: string,
  pending: boolean,
  abnormal: boolean,
): void {
  const latest = latestAuditVersion(entry)
  entry.versions.push({
    version: latest.version + 1,
    kind,
    recordedAt: nowIso(),
    operationTime: entry.operationTime,
    status,
    pending,
    abnormal,
    payload: clone(latest.payload),
  })
  if (status === '已归档' && !entry.archived) {
    entry.archived = true
    entry.archivedAt = nowIso()
  }
}

/**
 * 迁移中断期间用户仍按旧流程改数据：如果这条旧记录已经迁移过，
 * 把旧流程产生的最新状态作为新版本追加，避免续跑后详情/来源/影响行数落后。
 */
function syncLegacyChangeIntoVersionedStore(id: number, updated: Record<string, unknown>): void {
  const store = readVersionedStore()
  if (!store || store.active) {
    return
  }
  const entry = store.entries.find((item) => item.legacyId === id)
  if (!entry) {
    return
  }
  const latest = latestAuditVersion(entry)
  const status = String(updated.status ?? latest.status)
  const pending = typeof updated.pending === 'boolean' ? updated.pending : latest.pending
  const abnormal = typeof updated.abnormal === 'boolean' ? updated.abnormal : latest.abnormal
  if (latest.status === status && latest.pending === pending && latest.abnormal === abnormal) {
    return
  }
  appendVersion(entry, 'status-change', status, pending, abnormal)
  store.compatibility = buildCompatibilityReport(store)
  writeVersionedStore(store)
}

export function runLegacyAuditAction(id: number, action: string): ActionResult {
  const meta = auditMeta()
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const snapshot = readLegacySnapshot()
  if (snapshot.kind === 'corrupt') {
    return {
      ok: false,
      message: '旧存储内容损坏，先隔离/修复后再操作，避免覆盖原始内容',
    }
  }
  const blob =
    snapshot.kind === 'ok'
      ? snapshot.data
      : (cloneLegacy(seedLegacyStorage()) as Record<string, unknown>)
  const rawRows = Array.isArray(blob[AUDIT_MODULE_KEY]) ? (blob[AUDIT_MODULE_KEY] as unknown[]) : []
  const index = rawRows.findIndex(
    (row) => isPlainObject(row) && Number(row.id) === id,
  )
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rawRows[index]
  if (!isPlainObject(row)) {
    return { ok: false, message: `编号为 ${id} 的${meta.entity}内容损坏，已隔离等待处理` }
  }
  // 已经迁移过的归档日志进入追加式结构后就是冻结的；尚未迁移的仍走旧流程。
  const migrated = readVersionedStore()?.entries.find((entry) => entry.legacyId === id)
  if (migrated?.archived) {
    return { ok: false, message: '已归档日志在迁移后不可改写' }
  }
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rawRows]
  next[index] = updated
  const written = writeLegacyModules(blob, { [AUDIT_MODULE_KEY]: next })
  if (!written) {
    return { ok: false, message: '旧存储写入失败，审计日志未变更' }
  }
  syncLegacyChangeIntoVersionedStore(id, updated)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function runVersionedAuditAction(id: number, action: string): ActionResult {
  const meta = auditMeta()
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const store = readVersionedStore()
  if (!store?.active) {
    return { ok: false, message: '版本化审计存储尚未启用' }
  }
  const entry = store.entries.find((item) => item.id === id)
  if (!entry) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (entry.archived) {
    return { ok: false, message: '已归档日志不可改写' }
  }
  const latest = latestAuditVersion(entry)
  if (latest.status === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  appendVersion(
    entry,
    'status-change',
    target,
    target !== lastStatus,
    NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  )
  store.compatibility = buildCompatibilityReport(store)
  writeVersionedStore(store)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function runAuditAction(id: number, action: string): ActionResult {
  return isAuditVersionedActive()
    ? runVersionedAuditAction(id, action)
    : runLegacyAuditAction(id, action)
}

export type AuditCreateInput = Record<string, string>

export type AuditCreateResult =
  | { ok: true; message: string; row: EntryRow }
  | { ok: false; message: string }

export function createAuditRecord(input: AuditCreateInput): AuditCreateResult {
  const meta = auditMeta()
  const fields: AuditPayload = {}
  for (const field of meta.fields) {
    fields[field] = input[field] ?? ''
  }
  const operationTime = (input['执行时间'] || nowIso()).trim()
  if (Number.isNaN(Date.parse(operationTime))) {
    return { ok: false, message: '执行时间无法解析' }
  }
  const logId = (input['日志编号'] || '').trim()

  const store = readVersionedStore()
  if (store?.active) {
    const generatedLogId = logId || nextAuditLogId(store.entries.map((entry) => entry.logId))
    if (store.entries.some((entry) => entry.logId === generatedLogId)) {
      return { ok: false, message: `日志编号 ${generatedLogId} 已存在` }
    }
    const id = Math.max(store.nextId, nextAuditNumericId(store.entries))
    const recordedAt = nowIso()
    const entry: AuditEntry = {
      id,
      logId: generatedLogId,
      legacyId: null,
      sourceIndex: null,
      origin: 'native',
      operationTime,
      archived: false,
      archivedAt: null,
      versions: [
        {
          version: 1,
          kind: 'created',
          recordedAt,
          operationTime,
          status: '草稿',
          pending: true,
          abnormal: false,
          payload: { ...fields, 日志编号: generatedLogId, 执行时间: operationTime },
        },
      ],
    }
    store.entries.push(entry)
    store.nextId = id + 1
    store.compatibility = buildCompatibilityReport(store)
    writeVersionedStore(store)
    return { ok: true, message: `审计日志 ${generatedLogId} 已登记`, row: auditEntryToRow(entry) }
  }

  const snapshot = readLegacySnapshot()
  if (snapshot.kind === 'corrupt') {
    return { ok: false, message: '旧存储内容损坏，先隔离/修复后再登记，避免覆盖原始内容' }
  }
  const blob =
    snapshot.kind === 'ok'
      ? snapshot.data
      : (cloneLegacy(seedLegacyStorage()) as Record<string, unknown>)
  const rawRows = Array.isArray(blob[AUDIT_MODULE_KEY]) ? (blob[AUDIT_MODULE_KEY] as unknown[]) : []
  const ids = rawRows
    .filter(isPlainObject)
    .map((row) => Number(row.id))
    .filter((value) => Number.isFinite(value))
  const id = ids.length > 0 ? Math.max(...ids) + 1 : 1
  const generatedLogId = logId || nextAuditLogId(
    rawRows
      .filter(isPlainObject)
      .map((row) => (isScalar(row['日志编号']) ? String(row['日志编号']) : '')),
  )
  const row: EntryRow = {
    ...fields,
    id,
    status: '草稿',
    pending: true,
    abnormal: false,
    日志编号: generatedLogId,
    执行时间: operationTime,
  }
  const written = writeLegacyModules(blob, { [AUDIT_MODULE_KEY]: [...rawRows, row] })
  if (!written) {
    return { ok: false, message: '旧存储写入失败，审计日志未登记' }
  }
  return { ok: true, message: `审计日志 ${generatedLogId} 已登记`, row }
}

export type AuditRecordDetail = {
  id: number
  logId: string
  origin: 'legacy' | 'native'
  legacyId: number | null
  sourceIndex: number | null
  archived: boolean
  archivedAt: string | null
  operationTime: string
  versions: AuditVersion[]
}

/** 单条审计日志的版本明细；旧存储没有版本概念时给出单条「旧结构」版本。 */
export function auditRecordDetail(id: number): AuditRecordDetail | null {
  const store = readVersionedStore()
  if (store?.active) {
    const entry = store.entries.find((item) => item.id === id)
    if (!entry) {
      return null
    }
    return {
      id: entry.id,
      logId: entry.logId,
      origin: entry.origin,
      legacyId: entry.legacyId,
      sourceIndex: entry.sourceIndex,
      archived: entry.archived,
      archivedAt: entry.archivedAt,
      operationTime: entry.operationTime,
      versions: clone(entry.versions),
    }
  }

  const source = readLegacyAuditSource()
  const raw = source.rows.find((item) => isPlainObject(item) && Number(item.id) === id)
  const row = legacyRowFromRaw(raw)
  if (!row) {
    return null
  }
  return {
    id: row.id,
    logId: String(row['日志编号'] ?? ''),
    origin: 'legacy',
    legacyId: row.id,
    sourceIndex: source.rows.indexOf(raw),
    archived: String(row.status) === '已归档',
    archivedAt: null,
    operationTime: String(row['执行时间'] ?? ''),
    versions: [
      {
        version: 1,
        kind: 'migrated',
        recordedAt: '',
        operationTime: String(row['执行时间'] ?? ''),
        status: String(row.status),
        pending: Boolean(row.pending),
        abnormal: Boolean(row.abnormal),
        payload: { ...row },
      },
    ],
  }
}

function filterAuditRows(rows: AuditExportRow[], filters: Record<string, string>): AuditExportRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((item) =>
    pairs.every(([field, value]) =>
      String(item.row[field] ?? '').includes(value.trim()),
    ),
  )
}

/**
 * 完整审计导出：新旧记录都在，并按原操作时间排序；
 * 隔离记录单独附在原值区，保证损坏内容也能原样带出。
 */
export function buildAuditExport(filters: Record<string, string> = {}): AuditExportPayload {
  const meta = auditMeta()
  const store = readVersionedStore()
  const source: 'legacy' | 'versioned' = store?.active ? 'versioned' : 'legacy'
  const sourceVersion = store?.active ? 2 : 1
  let rows: AuditExportRow[] = []

  if (store?.active) {
    rows = sortAuditEntries(store.entries).map((entry) => {
      const latest = latestAuditVersion(entry)
      return {
        row: auditEntryToRow(entry),
        origin: entry.origin,
        version: latest.version,
        archived: entry.archived,
        sourceIndex: entry.sourceIndex,
      }
    })
  } else {
    const legacySource = readLegacyAuditSource()
    const mapped: AuditExportRow[] = []
    legacySource.rows.forEach((raw, index) => {
      const row = legacyRowFromRaw(raw)
      if (!row) {
        return
      }
      mapped.push({
        row,
        origin: 'legacy',
        version: 1,
        archived: row.status === '已归档',
        sourceIndex: index,
      })
    })
    rows = mapped.sort((left, right) => {
      const leftTime = Date.parse(String(left.row['执行时间'] ?? ''))
      const rightTime = Date.parse(String(right.row['执行时间'] ?? ''))
      if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime
      }
      return Number(left.row.id) - Number(right.row.id)
    })
  }

  rows = filterAuditRows(rows, filters)
  const quarantined = store?.quarantine ?? []
  const header = [
    '编号',
    ...meta.fields,
    '当前状态',
    '记录来源',
    '版本号',
    '归档状态',
    '迁移来源序号',
  ]
  const lines = [csvLine(header)]
  for (const item of rows) {
    lines.push(
      csvLine([
        item.row.id,
        ...meta.fields.map((field) => item.row[field] ?? ''),
        item.row.status,
        item.origin,
        item.version,
        item.archived ? '已归档' : '未归档',
        item.sourceIndex ?? '',
      ]),
    )
  }
  if (quarantined.length > 0) {
    lines.push('')
    lines.push(csvLine(['隔离记录']))
    lines.push(csvLine(['隔离原因', '原始位置', '原值', '校验值', '隔离时间']))
    for (const record of quarantined) {
      lines.push(
        csvLine([
          record.reason,
          record.sourceIndex,
          record.rawText,
          record.checksum,
          record.quarantinedAt,
        ]),
      )
    }
  }

  return {
    source,
    sourceVersion,
    rows,
    quarantined,
    filename: `${meta.name}-清单.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

export type AuditExportQueueItem = {
  id: string
  requestedBy: string
  requestedAt: string
  filters: Record<string, string>
  status: 'pending' | 'completed' | 'failed'
  filename: string | null
  content: string | null
  source: 'legacy' | 'versioned' | null
  sourceVersion: 1 | 2 | null
  rowCount: number
  error: string | null
  processedAt: string | null
}

const MAX_QUEUE_ITEMS = 100

function readExportQueue(): AuditExportQueueItem[] {
  const raw = getItem(AUDIT_EXPORT_QUEUE_KEY)
  if (raw === null) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as AuditExportQueueItem[]) : []
  } catch {
    return []
  }
}

function writeExportQueue(items: AuditExportQueueItem[]): void {
  setItem(AUDIT_EXPORT_QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUE_ITEMS)))
}

/** 跨模块的审计导出请求：任何模块都能入队，处理时读当前生效的数据源。 */
export function enqueueAuditExport(
  requestedBy: string,
  filters: Record<string, string> = {},
): AuditExportQueueItem {
  const queue = readExportQueue()
  const item: AuditExportQueueItem = {
    id: `export-${Date.now()}-${queue.length + 1}`,
    requestedBy,
    requestedAt: nowIso(),
    filters: { ...filters },
    status: 'pending',
    filename: null,
    content: null,
    source: null,
    sourceVersion: null,
    rowCount: 0,
    error: null,
    processedAt: null,
  }
  queue.push(item)
  writeExportQueue(queue)
  return item
}

export function listAuditExportQueue(): AuditExportQueueItem[] {
  return readExportQueue()
}

export function processAuditExportQueue(): {
  processed: number
  failed: number
  items: AuditExportQueueItem[]
} {
  const queue = readExportQueue()
  let processed = 0
  let failed = 0
  for (const item of queue) {
    if (item.status !== 'pending') {
      continue
    }
    try {
      const payload = buildAuditExport(item.filters ?? {})
      item.status = 'completed'
      item.filename = payload.filename
      item.content = payload.content
      item.source = payload.source
      item.sourceVersion = payload.sourceVersion
      item.rowCount = payload.rows.length
      item.error = null
      item.processedAt = nowIso()
      processed += 1
    } catch (error) {
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : '审计导出失败'
      item.processedAt = nowIso()
      failed += 1
    }
  }
  writeExportQueue(queue)
  return { processed, failed, items: queue }
}

export function clearAuditExportQueue(): void {
  removeItem(AUDIT_EXPORT_QUEUE_KEY)
}

/** 仅供测试/本地重置：彻底清掉版本化存储，重新回到旧数据源。 */
export function resetAuditMigrationStorage(): void {
  removeItem(AUDIT_STORE_KEY)
  removeItem(AUDIT_LEGACY_BACKUP_KEY)
  removeItem(AUDIT_EXPORT_QUEUE_KEY)
  // 本地开发的重置：旧存储可读时把审计段恢复成示例数据，回到迁移前的样子。
  const snapshot = readLegacySnapshot()
  if (snapshot.kind === 'ok') {
    writeLegacyModules(snapshot.data, {
      [AUDIT_MODULE_KEY]: cloneLegacy(SEED_ROWS[AUDIT_MODULE_KEY] ?? []),
    })
  }
  // 内存缓存里的旧表也要失效，否则重置后仍会读到迁移前的行。
  writeRowsCache(null)
}
