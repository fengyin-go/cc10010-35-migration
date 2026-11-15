import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

/**
 * 旧存储的进程内缓存。单独放一个模块，避免 local-store 与 audit-storage 互相 import
 * 形成运行时循环依赖（迁移/重置时两边都要让对方失效）。
 */
let cache: Record<string, EntryRow[]> | null = null

export function readRowsCache(): Record<string, EntryRow[]> | null {
  return cache
}

export function writeRowsCache(rows: Record<string, EntryRow[]> | null): void {
  cache = rows
}

export function seedFallbackRows(): Record<string, EntryRow[]> {
  return JSON.parse(JSON.stringify(SEED_ROWS)) as Record<string, EntryRow[]>
}
