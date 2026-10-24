import fs from "node:fs"
import path from "node:path"

/** 数据目录: <yunzai>/app/data/honkai-mys (与 honkai-mys 插件共用，保留历史记录) */
const DATA_DIR = path.join(process.cwd(), "data", "honkai-mys")
const FILE = path.join(DATA_DIR, "report.json")
const MAX_HISTORY = 30

let cache = null

function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"))
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {}
  } catch {
    cache = {}
  }
  return cache
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(cache), "utf8")
  } catch (err) {
    globalThis.logger?.error?.("[honkai-mys] 战报数据保存失败", err)
  }
}

function blank() {
  return { weekly: [], abyss: [], battle: [] }
}

function getUser(uid) {
  const store = load()
  const key = String(uid)
  const u = store[key]
  if (!u || typeof u !== "object" || Array.isArray(u)) {
    store[key] = blank()
  } else {
    for (const k of ["weekly", "abyss", "battle"]) {
      if (!Array.isArray(u[k])) u[k] = []
    }
  }
  return store[key]
}

function keyNum(k) {
  const n = Number(k)
  return Number.isFinite(n) ? n : null
}

/**
 * 合并历史记录: 按 entry.key 去重(新数据覆盖旧数据), 按 key 降序, 截断到 limit
 * @param {Array<{key:string,data:any}>} apiEntries 本次接口数据
 * @param {Array<{key:string,data:any}>} storedEntries 本地历史数据
 */
export function mergeEntries(apiEntries = [], storedEntries = [], limit = MAX_HISTORY) {
  const map = new Map()
  for (const it of storedEntries) {
    const k = String(it?.key ?? "")
    if (k) map.set(k, it)
  }
  for (const it of apiEntries) {
    const k = String(it?.key ?? "")
    if (k) map.set(k, it)
  }
  const arr = [...map.values()]
  arr.sort((a, b) => {
    const na = keyNum(a.key)
    const nb = keyNum(b.key)
    if (na !== null && nb !== null) return nb - na
    return String(b.key).localeCompare(String(a.key))
  })
  return arr.slice(0, limit)
}

/**
 * 持久化战报历史
 * @param uid 游戏uid
 * @param payload { weekly?:{key,data}, abyss?:[{key,data}], battle?:[{key,data}] }
 */
export function saveReports(uid, payload = {}) {
  const u = getUser(uid)
  if (payload.weekly) {
    u.weekly = mergeEntries([payload.weekly], u.weekly)
  }
  if (payload.abyss?.length) {
    u.abyss = mergeEntries(payload.abyss, u.abyss)
  }
  if (payload.battle?.length) {
    u.battle = mergeEntries(payload.battle, u.battle)
  }
  save()
}

/** 读取用户本地历史(均为 {key,data} 数组, 新的在前) */
export function getReports(uid) {
  const u = getUser(uid)
  return {
    weekly: [...u.weekly],
    abyss: [...u.abyss],
    battle: [...u.battle],
  }
}
