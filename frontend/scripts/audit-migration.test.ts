/**
 * 审计日志迁移的回归测试。用 esbuild 打包后在 Node 里跑，不需要浏览器：
 *   npm run test:audit
 */
import assert from 'node:assert/strict'

import {
  auditMigrationQueue,
  buildAuditExport,
  createAuditRecord,
  enqueueAuditExport,
  processAuditExportQueue,
  readLegacyAuditSource,
  resetAuditMigrationStorage,
  runAuditAction,
  runAuditMigration,
} from '../src/data/audit-storage'
import { LEGACY_STORAGE_KEY, readLegacySnapshot, writeLegacyBlob } from '../src/data/legacy-storage'
import { SEED_ROWS } from '../src/data/seed'
import { listEntries, runAction } from '../src/api/local-service'

type MemoryStorage = Storage

function installLocalStorage(): Map<string, string> {
  const data = new Map<string, string>()
  const storage: MemoryStorage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  }
  ;(globalThis as unknown as { window: { localStorage: MemoryStorage } }).window = {
    localStorage: storage,
  }
  return data
}

const storage = installLocalStorage()

function reset(): void {
  storage.clear()
  resetAuditMigrationStorage()
}

function writeLegacy(blob: Record<string, unknown>): void {
  writeLegacyBlob(blob)
}

function auditRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    status: '草稿',
    pending: true,
    abnormal: false,
    日志编号: 'AUDI-0001',
    操作类型: '发布目录',
    操作对象: '数据目录 CATA-0001',
    操作详情: '把目录发布到线上',
    操作来源: 'catalog',
    执行时间: '2026-09-01',
    影响行数: 12,
    回滚能力: '可回滚',
    ...overrides,
  }
}

const tests: [string, () => void][] = []
function test(name: string, fn: () => void): void {
  tests.push([name, fn])
}

test('全新环境迁移：切换数据源、清空旧审计段、重复执行不多副本', () => {
  reset()
  writeLegacy({ catalog: SEED_ROWS.catalog, audit: SEED_ROWS.audit })
  const first = runAuditMigration({ batchSize: 2 })
  assert.equal(first.ok, true)
  assert.equal(first.active, true)
  assert.equal(first.migrated, 3)

  const exportAfterFirst = buildAuditExport()
  assert.equal(exportAfterFirst.source, 'versioned')
  assert.equal(exportAfterFirst.rows.length, 3)

  const legacy = readLegacySnapshot()
  assert.equal(legacy.kind, 'ok')
  assert.deepEqual((legacy.data as Record<string, unknown>).audit, [])
  // 其他模块不能被迁移连带清掉
  assert.equal(((legacy.data as Record<string, unknown>).catalog as unknown[]).length, 3)

  const second = runAuditMigration({ batchSize: 2 })
  assert.equal(second.ok, true)
  assert.equal(second.migrated, 3)
  assert.equal(buildAuditExport().rows.length, 3)
})

test('迁移中的列表/动作仍按旧存储走，不提前切数据源', () => {
  reset()
  writeLegacy({
    catalog: SEED_ROWS.catalog,
    audit: [
      auditRow({ id: 1, 日志编号: 'AUDI-0001', 执行时间: '2026-09-02' }),
      auditRow({ id: 2, 日志编号: 'AUDI-0002', 执行时间: '2026-09-01' }),
      auditRow({ id: 3, 日志编号: 'AUDI-0003', 执行时间: '2026-09-03' }),
    ],
  })
  const first = runAuditMigration({ batchSize: 1, maxBatches: 1 })
  assert.equal(first.active, false)
  assert.equal(first.cursor, 1)

  // 迁移中断期间，页面读到的仍是旧记录，顺序也按旧存储原样（原有流程取数）
  const list = listEntries('audit')
  assert.equal(list.total, 3)
  assert.deepEqual(list.items.map((row) => row['日志编号']), ['AUDI-0001', 'AUDI-0002', 'AUDI-0003'])
  // 迁移队列本身按原操作时间排序
  const queue = auditMigrationQueue()
  assert.deepEqual(
    queue.map((item) => item.logId),
    ['AUDI-0002', 'AUDI-0001', 'AUDI-0003'],
  )

  // 旧流程的动作照旧生效
  const action = runAction('audit', 1, '提交审核')
  assert.equal(action.ok, true)
  assert.equal(String(listEntries('audit').items.find((row) => row.id === 1)?.status), '待审核')

  const resumed = runAuditMigration({ batchSize: 1 })
  assert.equal(resumed.active, true)
  assert.equal(resumed.migrated, 3)
})

test('迁移中断后从最后成功批次续跑，重复批次不产生副本', () => {
  reset()
  const rows = Array.from({ length: 7 }, (_, index) =>
    auditRow({
      id: index + 1,
      日志编号: `AUDI-${String(index + 1).padStart(4, '0')}`,
      执行时间: `2026-09-0${index + 1}`,
    }),
  )
  writeLegacy({ audit: rows })
  const first = runAuditMigration({ batchSize: 3, maxBatches: 1 })
  assert.equal(first.cursor, 3)
  assert.equal(first.migrated, 3)

  const second = runAuditMigration({ batchSize: 3, maxBatches: 1 })
  assert.equal(second.cursor, 6)
  assert.equal(second.migrated, 6)

  // restart 模拟重跑：已迁移的记录按来源下标幂等跳过
  const restarted = runAuditMigration({ batchSize: 3, restart: true })
  assert.equal(restarted.ok, true)
  assert.equal(restarted.migrated, 7)
  assert.equal(buildAuditExport().rows.length, 7)
})

test('损坏记录被隔离且保留原值，正常记录继续迁移', () => {  reset()
  const broken = auditRow({ id: 2, 日志编号: '', 执行时间: '2026-09-02' })
  const notObject = 'this is not a row'
  const badField = auditRow({ id: 4, 日志编号: 'AUDI-0004', 影响行数: { nested: true } })
  const duplicate = auditRow({ id: 5, 日志编号: 'AUDI-0001', 执行时间: '2026-09-05' })
  writeLegacy({
    audit: [
      auditRow({ id: 1, 日志编号: 'AUDI-0001', 执行时间: '2026-09-01' }),
      broken,
      notObject,
      auditRow({ id: 3, 日志编号: 'AUDI-0003', 执行时间: '2026-09-03' }),
      badField,
      duplicate,
    ],
  })
  const result = runAuditMigration({ batchSize: 4 })
  assert.equal(result.active, true)
  assert.equal(result.migrated, 2)
  assert.equal(result.quarantined, 4)

  const payload = buildAuditExport()
  assert.equal(payload.quarantined.length, 4)
  const rawTexts = payload.quarantined.map((record) => record.rawText)
  assert.ok(rawTexts.includes(JSON.stringify(notObject)))
  assert.ok(rawTexts.includes(JSON.stringify(broken)))
  assert.ok(rawTexts.includes(JSON.stringify(badField)))
  assert.ok(rawTexts.includes(JSON.stringify(duplicate)))
  // 隔离记录的原值也要出现在导出文件里（CSV 里按 RFC4180 转义）
  const escapeCsv = (text: string) => `"${text.replace(/"/g, '""')}"`
  assert.ok(payload.content.includes(escapeCsv(JSON.stringify(broken))))
  assert.ok(payload.content.includes(escapeCsv('this is not a row')))

  // 重复迁移不会再增加隔离副本
  const again = runAuditMigration()
  assert.equal(again.quarantined, 4)
})

test('已归档日志迁移后不可改写，状态变化只追加版本', () => {
  reset()
  writeLegacy({
    audit: [
      auditRow({ id: 1, status: '已归档', pending: false, 日志编号: 'AUDI-0001', 执行时间: '2026-09-01' }),
      auditRow({ id: 2, status: '待审核', pending: true, 日志编号: 'AUDI-0002', 执行时间: '2026-09-02' }),
    ],
  })
  runAuditMigration()
  assert.equal(buildAuditExport().rows.find((item) => item.row.id === 1)?.archived, true)

  const blocked = runAuditAction(1, '忽略日志')
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /已归档/)

  const changed = runAuditAction(2, '归档日志')
  assert.equal(changed.ok, true)
  const exportAfter = buildAuditExport()
  const archived = exportAfter.rows.find((item) => item.row.id === 2)
  assert.equal(archived?.archived, true)
  assert.equal(archived?.version, 2)
  const blockedAgain = runAuditAction(2, '忽略日志')
  assert.equal(blockedAgain.ok, false)
})

test('完整导出包含迁移前后记录，并按原操作时间排序', () => {
  reset()
  writeLegacy({
    audit: [
      auditRow({ id: 1, 日志编号: 'AUDI-0001', 执行时间: '2026-09-05', 影响行数: 5 }),
      auditRow({ id: 2, 日志编号: 'AUDI-0002', 执行时间: '2026-09-02', 影响行数: 2 }),
    ],
  })
  runAuditMigration()
  const created = createAuditRecord({
    日志编号: 'AUDI-0003',
    操作类型: '登记',
    操作对象: '审计日志',
    操作详情: '迁移后新增',
    操作来源: 'audit',
    执行时间: '2026-09-03',
    影响行数: '1',
    回滚能力: '否',
  })
  assert.equal(created.ok, true)

  const payload = buildAuditExport()
  assert.equal(payload.source, 'versioned')
  assert.deepEqual(
    payload.rows.map((item) => item.row['日志编号']),
    ['AUDI-0002', 'AUDI-0003', 'AUDI-0001'],
  )
  assert.deepEqual(
    payload.rows.map((item) => item.origin),
    ['legacy', 'native', 'legacy'],
  )
  // 旧字段值原样保留
  assert.equal(String(payload.rows[0].row['影响行数']), '2')
  assert.ok(payload.content.startsWith('﻿'))
})

test('旧存储整体损坏时不覆写原文，原值进入隔离区并按示例数据回退', () => {
  reset()
  storage.set(LEGACY_STORAGE_KEY, '{not valid json')
  const result = runAuditMigration()
  assert.equal(result.ok, true)
  // 损坏原文必须保留
  assert.equal(storage.get(LEGACY_STORAGE_KEY), '{not valid json')
  const payload = buildAuditExport()
  assert.ok(payload.quarantined.some((record) => record.rawText === '{not valid json'))
  // 升级前的回退规则：按示例数据取值
  assert.equal(payload.rows.length, SEED_ROWS.audit.length)
})

test('旧存储里的审计段不是数组时隔离原值并继续', () => {
  reset()
  writeLegacy({ audit: { broken: true }, catalog: [] })
  const source = readLegacyAuditSource()
  assert.equal(source.segmentError !== null, true)
  const result = runAuditMigration()
  assert.equal(result.ok, true)
  const payload = buildAuditExport()
  assert.ok(payload.quarantined.some((record) => record.rawText === JSON.stringify({ broken: true })))
  assert.equal(payload.rows.length, 0)
})

test('跨模块审计导出队列在迁移后读取版本化历史日志', () => {
  reset()
  writeLegacy({
    audit: [
      auditRow({ id: 1, 日志编号: 'AUDI-0001', 执行时间: '2026-09-01' }),
      auditRow({ id: 2, 日志编号: 'AUDI-0002', 执行时间: '2026-09-02' }),
    ],
  })
  const before = enqueueAuditExport('backfill')
  const processedBefore = processAuditExportQueue()
  assert.equal(processedBefore.processed, 1)
  const legacyItem = processedBefore.items.find((item) => item.id === before.id)
  assert.equal(legacyItem?.source, 'legacy')
  assert.equal(legacyItem?.sourceVersion, 1)

  runAuditMigration()
  const after = enqueueAuditExport('resource')
  const processedAfter = processAuditExportQueue()
  const versionedItem = processedAfter.items.find((item) => item.id === after.id)
  assert.equal(versionedItem?.status, 'completed')
  assert.equal(versionedItem?.source, 'versioned')
  assert.equal(versionedItem?.sourceVersion, 2)
  assert.equal(versionedItem?.rowCount, 2)
})

test('首次使用就直接迁移：旧存储落示例数据，审计段留空', () => {
  reset()
  const result = runAuditMigration()
  assert.equal(result.ok, true)
  assert.equal(result.active, true)
  assert.equal(result.migrated, SEED_ROWS.audit.length)
  const snapshot = readLegacySnapshot()
  assert.equal(snapshot.kind, 'ok')
  const data = snapshot.data as Record<string, unknown>
  assert.deepEqual(data.audit, [])
  assert.equal((data.catalog as unknown[]).length, SEED_ROWS.catalog.length)
})

test('迁移沿用旧数字编号，重复编号不覆盖已迁移记录', () => {
  reset()
  writeLegacy({
    audit: [
      auditRow({ id: 10, 日志编号: 'AUDI-0010', 执行时间: '2026-09-01' }),
      auditRow({ id: 10, 日志编号: 'AUDI-0011', 执行时间: '2026-09-02' }),
    ],
  })
  runAuditMigration()
  const payload = buildAuditExport()
  assert.equal(payload.rows.length, 2)
  assert.equal(payload.rows[0].row.id, 10)
  assert.notEqual(payload.rows[1].row.id, 10)
  // 后一条重复编号的记录换新号保留，不覆盖前一条
  assert.equal(payload.rows[1].row['日志编号'], 'AUDI-0011')
  assert.equal(payload.quarantined.length, 0)
})

test('迁移中断期间旧流程的动作会在续跑后体现为追加版本', () => {
  reset()
  writeLegacy({
    audit: [
      auditRow({ id: 1, 日志编号: 'AUDI-0001', 执行时间: '2026-09-01' }),
      auditRow({ id: 2, 日志编号: 'AUDI-0002', 执行时间: '2026-09-02' }),
    ],
  })
  const first = runAuditMigration({ batchSize: 1, maxBatches: 1 })
  assert.equal(first.migrated, 1)
  const action = runAction('audit', 1, '提交审核')
  assert.equal(action.ok, true)
  runAuditMigration({ batchSize: 1 })

  const payload = buildAuditExport()
  const migratedRow = payload.rows.find((item) => item.row.id === 1)
  assert.equal(String(migratedRow?.row.status), '待审核')
  assert.equal(migratedRow?.version, 2)
  // 详情/来源/影响行数仍按原值
  assert.equal(String(migratedRow?.row['操作详情']), '把目录发布到线上')
  assert.equal(String(migratedRow?.row['操作来源']), 'catalog')
  assert.equal(String(migratedRow?.row['影响行数']), '12')
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`)
  process.exitCode = 1
} else {
  console.log(`\n${tests.length} 个用例全部通过`)
}
