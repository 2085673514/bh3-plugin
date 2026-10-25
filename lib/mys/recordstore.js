import fs from "node:fs"
import path from "node:path"

/** 数据目录: <yunzai>/app/data/honkai-mys (与 honkai-mys 插件共用，保留历史记录) */
const DATA_DIR = path.join(process.cwd(), "data", "honkai-mys")
const LEGACY_FILE = path.join(DATA_DIR, "records.json")

/** 每个用户每个类别单独一个 NDJSON 文件: <uid>/<category>.jsonl
 *  采用 JSON Lines(逐行 JSON)追加写入: 新增记录只 append, 不重写整个文件,
 *  适合后续数千条记录的增量持久化; 读取时按 key 去重、按时间倒序。 */
function dirOf(uid) {
  return path.join(DATA_DIR, String(uid))
}
function fileOf(uid, category) {
  return path.join(dirOf(uid), `${category}.jsonl`)
}
function menuFile(uid) {
  return path.join(dirOf(uid), "menus.json")
}
function metaFile(uid) {
  return path.join(dirOf(uid), "meta.json")
}

/** 是否已对该类别做过一次「全量抓取」 */
const fullCache = new Map()
export function isFullFetched(uid, category) {
  const k = `${uid}:${category}`
  if (fullCache.has(k)) return fullCache.get(k)
  let v = false
  try {
    const all = JSON.parse(fs.readFileSync(metaFile(uid), "utf8"))
    v = !!all?.full?.[category]
  } catch {
    v = false
  }
  fullCache.set(k, v)
  return v
}

/** 标记该类别已全量抓取 */
export function markFullFetched(uid, category) {
  try {
    const dir = dirOf(uid)
    fs.mkdirSync(dir, { recursive: true })
    let all = {}
    try {
      all = JSON.parse(fs.readFileSync(metaFile(uid), "utf8")) || {}
    } catch {
      all = {}
    }
    all.full = all.full || {}
    all.full[category] = true
    fs.writeFileSync(metaFile(uid), JSON.stringify(all), "utf8")
  } catch (err) {
    globalThis.logger?.error?.("[honkai-mys] 抓取标记保存失败", err)
  }
  fullCache.set(`${uid}:${category}`, true)
}

/** 单条记录的唯一 key(不含重复序号) */
export function recordKey(item = []) {
  return item.map(x => `${x.label}=${x.value}`).join("|")
}
/** 归一化历史 key: 旧数据无 |#序号 后缀, 视为该组合的第 0 条 */
function normKey(k = "") {
  return /\|#\d+$/.test(k) ? k : `${k}|#0`
}
/** 记录时间(用于排序), 取第一个字段的值 */
function timeOf(item = []) {
  return (item[0] && item[0].value) || ""
}

/** 读取某用户某类别的全部记录(去重 + 时间倒序), 带内存缓存 */
const cache = new Map()
function readAll(uid, category) {
  const cacheKey = `${uid}:${category}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)
  const map = new Map()
  try {
    const text = fs.readFileSync(fileOf(uid, category), "utf8")
    for (const line of text.split("\n")) {
      if (!line) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row && row.k) {
        row.k = normKey(row.k)
        map.set(row.k, row) // 同一 key 以最后一行为准
      }
    }
  } catch {
    /* 文件不存在 */
  }
  const list = [...map.values()].sort((a, b) => String(b.t).localeCompare(String(a.t)))
  cache.set(cacheKey, list)
  return list
}

/** 追加记录(只写新增行) */
function append(uid, category, rows) {
  if (!rows.length) return
  const dir = dirOf(uid)
  fs.mkdirSync(dir, { recursive: true })
  const text = rows.map(r => JSON.stringify(r)).join("\n") + "\n"
  fs.appendFileSync(fileOf(uid, category), text, "utf8")
  cache.delete(`${uid}:${category}`)
  maybeCompact(uid, category)
}

/** NDJSON 文件超过 5MB 时重写一次：按 key 去重、按时间倒序，避免无限膨胀 */
const MAX_LOG_BYTES = 5 * 1024 * 1024
function maybeCompact(uid, category) {
  const file = fileOf(uid, category)
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return
    const list = readAll(uid, category)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, list.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8")
    fs.renameSync(tmp, file)
    cache.delete(`${uid}:${category}`)
    globalThis.logger?.mark?.(`[honkai-mys] ${category}.jsonl 已压缩去重（${list.length} 条）`)
  } catch (err) {
    globalThis.logger?.warn?.(`[honkai-mys] 记录文件压缩失败: ${err.message}`)
  }
}

/**
 * 保存(增量)记录: 只追加本地不存在的记录
 * @param {Array<{key:string,item:Array}>} apiRecords 本次接口数据
 * @returns {{ added:number, total:number }}
 */
export function saveRecords(uid, category, type, apiRecords = []) {
  const existing = readAll(uid, category)
  const keys = new Set(existing.map(r => r.k))
  const fresh = []
  for (const r of apiRecords) {
    if (!r?.key || keys.has(r.key)) continue
    keys.add(r.key)
    fresh.push({ k: r.key, type: String(type), t: timeOf(r.item), i: r.item })
  }
  append(uid, category, fresh)
  const total = fresh.length + existing.filter(r => r.type === String(type)).length
  return { added: fresh.length, total }
}

/** 读取本地某类型记录(新的在前) */
export function getRecords(uid, category, type) {
  return readAll(uid, category)
    .filter(r => r.type === String(type))
    .map(r => ({ key: r.k, item: r.i }))
}

/** 本地是否已有某类记录 */
export function hasRecords(uid, category, type) {
  return getRecords(uid, category, type).length > 0
}

/** 保存记录分类标签(type -> label) */
export function setMenus(uid, category, menus = []) {
  try {
    const dir = dirOf(uid)
    fs.mkdirSync(dir, { recursive: true })
    let all = {}
    try {
      all = JSON.parse(fs.readFileSync(menuFile(uid), "utf8")) || {}
    } catch {
      all = {}
    }
    all[category] = menus.map(m => ({ type: m.type, label: m.label }))
    fs.writeFileSync(menuFile(uid), JSON.stringify(all), "utf8")
  } catch (err) {
    globalThis.logger?.error?.("[honkai-mys] 卡池标签保存失败", err)
  }
}

/** 读取记录分类标签 */
export function getMenus(uid, category) {
  try {
    const all = JSON.parse(fs.readFileSync(menuFile(uid), "utf8")) || {}
    return Array.isArray(all[category]) ? all[category] : []
  } catch {
    return []
  }
}

/** 从旧的单文件 records.json 迁移到新的分文件结构 */
export function migrateLegacy() {
  let legacy
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"))
  } catch {
    return
  }
  if (!legacy || typeof legacy !== "object") return
  try {
    for (const [uid, u] of Object.entries(legacy)) {
      for (const category of ["gacha", "material", "hcoin"]) {
        const types = u?.[category] || {}
        for (const [type, list] of Object.entries(types)) {
          if (!Array.isArray(list)) continue
          const existing = new Set(readAll(uid, category).map(r => r.k))
          const rows = list
            .filter(r => r?.key && !existing.has(r.key))
            .map(r => ({ k: r.key, type: String(type), t: timeOf(r.item), i: r.item }))
          append(uid, category, rows)
        }
      }
      if (u?.menus) {
        for (const [category, menus] of Object.entries(u.menus)) {
          if (Array.isArray(menus) && menus.length) setMenus(uid, category, menus)
        }
      }
    }
    fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.bak`)
    globalThis.logger?.mark?.("[honkai-mys] 记录数据已迁移到分文件存储")
  } catch (err) {
    globalThis.logger?.error?.("[honkai-mys] 记录数据迁移失败", err)
  }
}
