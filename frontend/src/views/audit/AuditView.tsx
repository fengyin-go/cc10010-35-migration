import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  auditCompatibilityReport,
  auditMigrationEnvironment,
  auditMigrationQueue,
  auditMigrationState,
  auditRecordDetail,
  auditStoreKey,
  buildAuditExport,
  downloadEntries,
  enqueueAuditExport,
  listAuditExportQueue,
  listEntries,
  moduleMeta,
  processAuditExportQueue,
  registerAuditLog,
  retryAuditMigration,
  retryAuditMigrationBatch,
  runAction as applyAction,
  runAuditMigration,
} from '@/api/local-service'
import type {
  AuditCompatibilityReport,
  AuditExportQueueItem,
  AuditMigrationEnvironment,
  AuditMigrationQueueItem,
  AuditMigrationState,
  AuditRecordDetail,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('audit')
const columns = [
  "日志编号",
  "操作类型",
  "操作对象",
  "操作详情",
  "操作来源",
  "执行时间",
  "影响行数",
  "回滚能力"
]
const actions = [
  "提交审核",
  "归档日志",
  "忽略日志"
]
const statuses = [
  "草稿",
  "待审核",
  "已归档",
  "已忽略"
]

const QUEUE_LABEL: Record<AuditMigrationQueueItem['status'], string> = {
  pending: '待迁移',
  migrated: '已迁移',
  quarantined: '已隔离',
  failed: '待重试',
}

export default function AuditView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [migration, setMigration] = useState<AuditMigrationState | null>(null)
  const [compatibility, setCompatibility] = useState<AuditCompatibilityReport | null>(null)
  const [migrationQueue, setMigrationQueue] = useState<AuditMigrationQueueItem[]>([])
  const [environment, setEnvironment] = useState<AuditMigrationEnvironment | null>(null)
  const [exportQueue, setExportQueue] = useState<AuditExportQueueItem[]>([])
  const [details, setDetails] = useState<Record<number, AuditRecordDetail>>({})
  const [registerOpen, setRegisterOpen] = useState(false)
  const [registerValues, setRegisterValues] = useState<Record<string, string>>({})
  const [batchSize, setBatchSize] = useState(50)

  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const refreshAuditState = useCallback(() => {
    setMigration(auditMigrationState())
    setCompatibility(auditCompatibilityReport())
    setMigrationQueue(auditMigrationQueue())
    setEnvironment(auditMigrationEnvironment())
    setExportQueue(listAuditExportQueue())
  }, [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '操作审计列表读取失败')
    }
    refreshAuditState()
  }, [filters, refreshAuditState])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    try {
      const result = applyAction(meta.key, Number(row.id), action)
      if (!result.ok) {
        setErrorMessage(result.message)
        return
      }
      setNotice(result.message)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '审计日志动作执行失败')
    }
    reload()
  }

  function handleMigrate(mode: 'all' | 'step' | 'retry' | 'retry-last') {
    setErrorMessage('')
    try {
      const result =
        mode === 'all'
          ? runAuditMigration({ batchSize })
          : mode === 'step'
            ? runAuditMigration({ batchSize, maxBatches: 1 })
            : mode === 'retry'
              ? retryAuditMigration()
              : retryAuditMigrationBatch()
      if (!result.ok) {
        setErrorMessage(result.message)
      } else {
        setNotice(result.message)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '审计日志迁移执行失败')
    }
    reload()
  }

  function handleRegister() {
    const logId = (registerValues['日志编号'] ?? '').trim()
    const values = {
      ...registerValues,
      日志编号: logId || `AUDI-${String(Date.now()).slice(-6)}`,
    }
    try {
      const result = registerAuditLog(values)
      if (!result.ok) {
        setErrorMessage(result.message)
        return
      }
      setNotice(result.message)
      setRegisterValues({})
      setRegisterOpen(false)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '审计日志登记失败')
    }
    reload()
  }

  function handleEnqueueExport() {
    setErrorMessage('')
    try {
      const item = enqueueAuditExport('操作审计页面')
      setNotice(`跨模块审计导出请求 ${item.id} 已入队`)
      setExportQueue(listAuditExportQueue())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '审计导出请求入队失败')
    }
  }

  function handleProcessExportQueue() {
    setErrorMessage('')
    try {
      const result = processAuditExportQueue()
      setNotice(`导出队列处理完成：成功 ${result.processed} 个，失败 ${result.failed} 个`)
      setExportQueue(result.items)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '审计导出队列处理失败')
    }
  }

  function handlePreviewExport() {
    setErrorMessage('')
    const payload = buildAuditExport(filters)
    setNotice(
      `当前导出读取 ${payload.source === 'versioned' ? '版本化存储（v2）' : '旧存储（v1）'}，` +
        `记录 ${payload.rows.length} 条，隔离 ${payload.quarantined.length} 条`,
    )
  }

  function toggleDetail(row: EntryRow) {
    const id = Number(row.id)
    if (details[id]) {
      setDetails((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return
    }
    const detail = auditRecordDetail(id)
    if (!detail) {
      setErrorMessage(`没有找到编号为 ${id} 的审计日志版本明细`)
      return
    }
    setDetails((prev) => ({ ...prev, [id]: detail }))
  }

  const stats = [
    { label: '审计日志总数', value: total },
    { label: '已归档日志', value: rows.filter((row) => String(row.status) === '已归档').length },
    { label: '待审核日志', value: rows.filter((row) => String(row.status) === '待审核').length },
    { label: '已迁移历史日志', value: compatibility?.migrated ?? 0 },
    { label: '隔离记录', value: compatibility?.quarantined ?? 0 },
  ]

  const progress = migration
    ? `${migration.cursor} / ${migration.total}`
    : '0 / 0'
  const activeSource = compatibility?.activeSource === 'versioned' ? '版本化存储 v2' : '旧存储 v1'
  const done = migration?.status === 'completed'
  const hasFailedBatch = migration?.batches.some((batch) => batch.status === 'failed') ?? false

  return (
    <section className="page" data-module="audit">
      <header className="page-head">
        <div>
          <h2>操作审计管理</h2>
          <p className="page-desc">维护操作审计日志的输入、执行约束与结果记录，为操作审计提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setRegisterOpen((prev) => !prev)}>
            登记审计日志
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出操作审计清单
          </button>
          <button className="btn ghost" type="button" onClick={handlePreviewExport}>
            预览导出范围
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      {registerOpen && (
        <section className="panel">
          <h3 className="panel-title">登记审计日志（状态从「草稿」开始）</h3>
          <div className="form-grid">
            {meta.fields.map((field) => (
              <label key={field} className="filter-item">
                <span>{field}</span>
                <input
                  value={registerValues[field] ?? ''}
                  placeholder={field === '执行时间' ? '留空则使用当前时间' : `填写${field}`}
                  onChange={(event) =>
                    setRegisterValues((prev) => ({ ...prev, [field]: event.target.value }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="panel-actions">
            <button className="btn primary" type="button" onClick={handleRegister}>提交登记</button>
            <button className="btn ghost" type="button" onClick={() => setRegisterOpen(false)}>取消</button>
          </div>
        </section>
      )}

      <section className="panel" data-testid="audit-migration">
        <div className="panel-head">
          <h3 className="panel-title">审计日志存储迁移（追加式版本结构）</h3>
          <span className={`badge badge-${migration?.status ?? 'pending'}`}>
            状态：{migration?.status ?? 'pending'}
          </span>
        </div>
        <div className="kv-row">
          <span>当前数据源：<strong>{activeSource}</strong></span>
          <span>迁移进度：<strong>{progress}</strong></span>
          <span>批次大小：<strong>{migration?.batchSize ?? batchSize}</strong></span>
          <span>成功批次：<strong>{migration?.batches.filter((batch) => batch.status === 'success').length ?? 0}</strong></span>
          <span>版本化存储键：<code>{auditStoreKey()}</code></span>
        </div>
        <div className="kv-row">
          <span>存储版本读取：<strong>v{environment?.storageVersion ?? 1}</strong>（旧结构 unversioned）</span>
          <span>运行环境：<strong>{environment?.environment.mode ?? 'unknown'}</strong></span>
          <span>构建依赖：<strong>{environment?.buildDependencies.package}@{environment?.buildDependencies.version}</strong>
            （react {environment?.buildDependencies.react} / vite {environment?.buildDependencies.vite} / tsc {environment?.buildDependencies.typescript}）
          </span>
        </div>
        <div className="panel-actions">
          <label className="filter-item">
            <span>批次大小</span>
            <input
              type="number"
              min={1}
              value={batchSize}
              onChange={(event) => setBatchSize(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          <button
            className="btn primary"
            type="button"
            disabled={done}
            onClick={() => handleMigrate('all')}
          >
            执行迁移直到完成
          </button>
          <button
            className="btn"
            type="button"
            disabled={done}
            onClick={() => handleMigrate('step')}
          >
            只跑一个批次
          </button>
          <button
            className="btn"
            type="button"
            disabled={done || !hasFailedBatch}
            onClick={() => handleMigrate('retry')}
          >
            重试全部失败批次
          </button>
          <button
            className="btn ghost"
            type="button"
            disabled={done}
            onClick={() => handleMigrate('retry-last')}
          >
            回填单个失败批次
          </button>
        </div>
        {migration?.error && <p className="error-text">{migration.error}</p>}
        {migration && migration.batches.length > 0 && (
          <table className="data-table compact">
            <thead>
              <tr><th>批次</th><th>区间</th><th>结果</th><th>导入</th><th>跳过</th><th>隔离</th><th>完成时间</th></tr>
            </thead>
            <tbody>
              {migration.batches.map((batch) => (
                <tr key={batch.batchId}>
                  <td>{batch.batchId}</td>
                  <td>{batch.from + 1} - {batch.to}</td>
                  <td>{batch.status === 'success' ? '成功' : '失败'}</td>
                  <td>{batch.imported}</td>
                  <td>{batch.skipped}</td>
                  <td>{batch.quarantined}</td>
                  <td>{batch.finishedAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" data-testid="audit-compatibility">
        <h3 className="panel-title">旧日志兼容结果</h3>
        {compatibility ? (
          <>
            <div className="kv-row">
              <span>兼容状态：<strong>{compatibility.status}</strong></span>
              <span>旧结构：<strong>{compatibility.legacySchema}</strong></span>
              <span>旧日志总数：<strong>{compatibility.totalLegacy}</strong></span>
              <span>已迁移：<strong>{compatibility.migrated}</strong></span>
              <span>待迁移：<strong>{compatibility.pending}</strong></span>
              <span>已隔离：<strong>{compatibility.quarantined}</strong></span>
              <span>原归档保留：<strong>{compatibility.archivedPreserved}</strong></span>
              <span>旧流程可读：<strong>{compatibility.oldFlowReadable ? '是' : '否'}</strong></span>
              <span>完整导出：<strong>{compatibility.completeExport ? '是' : '否'}</strong></span>
            </div>
            <p className="muted-note">保留字段：{compatibility.fieldsPreserved.join('、')}</p>
            <ul className="note-list">
              {compatibility.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </>
        ) : (
          <p className="muted-note">尚未建立兼容结果。</p>
        )}
      </section>

      <section className="panel" data-testid="audit-migration-queue">
        <div className="panel-head">
          <h3 className="panel-title">历史日志迁移队列（按原操作时间排序）</h3>
          <span className="muted-note">共 {migrationQueue.length} 条</span>
        </div>
        <table className="data-table compact">
          <thead>
            <tr><th>原序号</th><th>日志编号</th><th>原编号</th><th>操作时间</th><th>状态</th><th>批次</th><th>说明</th></tr>
          </thead>
          <tbody>
            {migrationQueue.map((item) => (
              <tr key={`${item.sourceIndex}-${item.logId ?? 'unknown'}`}>
                <td>{item.sourceIndex + 1}</td>
                <td>{item.logId ?? '—'}</td>
                <td>{item.sourceId ?? '—'}</td>
                <td>{item.operationTime || '—'}</td>
                <td>{QUEUE_LABEL[item.status]}</td>
                <td>{item.batchId ?? '—'}</td>
                <td>{item.reason ?? '—'}</td>
              </tr>
            ))}
            {migrationQueue.length === 0 && (
              <tr><td className="empty-state" colSpan={7}>当前没有待迁移或已迁移的历史日志</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel" data-testid="audit-export-queue">
        <div className="panel-head">
          <h3 className="panel-title">跨模块审计导出队列</h3>
          <span className="muted-note">处理时读取当前生效的数据源，迁移后即为版本化存储</span>
        </div>
        <div className="panel-actions">
          <button className="btn" type="button" onClick={handleEnqueueExport}>提交导出请求</button>
          <button className="btn" type="button" onClick={handleProcessExportQueue}>处理导出队列</button>
        </div>
        <table className="data-table compact">
          <thead>
            <tr><th>请求</th><th>来源</th><th>状态</th><th>记录数</th><th>读取数据源</th><th>处理时间</th></tr>
          </thead>
          <tbody>
            {exportQueue.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.requestedBy}</td>
                <td>{item.status}</td>
                <td>{item.rowCount}</td>
                <td>{item.source ? `${item.source} v${item.sourceVersion}` : '—'}</td>
                <td>{item.processedAt ?? '—'}</td>
              </tr>
            ))}
            {exportQueue.length === 0 && (
              <tr><td className="empty-state" colSpan={6}>还没有跨模块导出请求</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
                <button className="link" type="button" onClick={() => toggleDetail(row)}>版本</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无操作审计数据，可先登记审计日志</td>
            </tr>
          )}
        </tbody>
      </table>

      {Object.keys(details).length > 0 && (
        <section className="panel">
          <h3 className="panel-title">版本记录</h3>
          {Object.entries(details).map(([id, detail]) => (
            <div key={id} className="detail-block">
              <p className="muted-note">
                记录 {id}（{detail.logId}）：来源 {detail.origin}，
                原编号 {detail.legacyId ?? '—'}，原序号 {detail.sourceIndex ?? '—'}，
                {detail.archived ? '已归档不可改写' : '未归档'}
              </p>
              <table className="data-table compact">
                <thead>
                  <tr><th>版本</th><th>类型</th><th>状态</th><th>操作时间</th><th>记录时间</th></tr>
                </thead>
                <tbody>
                  {detail.versions.map((version) => (
                    <tr key={version.version}>
                      <td>v{version.version}</td>
                      <td>{version.kind}</td>
                      <td>{version.status}</td>
                      <td>{version.operationTime}</td>
                      <td>{version.recordedAt || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      <footer className="page-foot">
        <span>共 {total} 条操作审计记录</span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
