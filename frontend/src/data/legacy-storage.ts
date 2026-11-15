import { SEED_ROWS } from './seed'

/**
 * 旧版（无版本标记）本地存储的读写入口。
 *
 * 升级前所有业务数据都塞在同一份 JSON 里：`{ "catalog": [...], "audit": [...] }`，
 * 没有任何版本标记。审计日志迁移必须以这份数据为唯一上游，并且：
 *
 * - 读取时不能覆盖无法解析的原始内容，原值要留给隔离区；
 * - 写入时只按模块合并，不能顺手把整份旧数据重置成示例数据。
 */
export const LEGACY_STORAGE_KEY = 'lake-govern-config:entries'

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

/** 没有 localStorage 时（Node 测试、SSR）退化成进程内存储，读写语义保持一致。 */
const memoryFallback = new Map<string, string>()

function getRaw(key: string): string | null {
  if (hasLocalStorage()) {
    return window.localStorage.getItem(key)
  }
  return memoryFallback.get(key) ?? null
}

function setRaw(key: string, value: string): void {
  if (hasLocalStorage()) {
    window.localStorage.setItem(key, value)
    return
  }
  memoryFallback.set(key, value)
}

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type LegacyBlob = PlainObject

export type LegacySnapshot =
  | { kind: 'missing'; raw: null; data: null }
  | { kind: 'ok'; raw: string; data: LegacyBlob }
  | { kind: 'corrupt'; raw: string; data: null; error: string }

export function readLegacySnapshot(): LegacySnapshot {
  const raw = getRaw(LEGACY_STORAGE_KEY)
  if (raw === null) {
    return { kind: 'missing', raw: null, data: null }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isPlainObject(parsed)) {
      return { kind: 'corrupt', raw, data: null, error: '旧存储内容不是 JSON 对象' }
    }
    return { kind: 'ok', raw, data: parsed }
  } catch (error) {
    return {
      kind: 'corrupt',
      raw,
      data: null,
      error: error instanceof Error ? error.message : '旧存储内容无法解析',
    }
  }
}

export function writeLegacyBlob(data: unknown): boolean {
  try {
    setRaw(LEGACY_STORAGE_KEY, JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

/**
 * 按模块写回旧存储：只替换给定的那几个 key，其余模块原样保留。
 * 旧存储损坏时拒绝写入，避免把无法解析的原值覆盖掉。
 */
export function writeLegacyModules(
  base: LegacyBlob,
  modules: Record<string, unknown>,
): boolean {
  const next: LegacyBlob = { ...base }
  for (const [key, value] of Object.entries(modules)) {
    next[key] = value
  }
  return writeLegacyBlob(next)
}

/** 首次使用（既没有新结构也没有旧数据）时，把示例数据灌进旧存储。 */
export function seedLegacyStorage(): LegacyBlob {
  const seed = clone(SEED_ROWS) as LegacyBlob
  writeLegacyBlob(seed)
  return seed
}
