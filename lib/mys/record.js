import {
  recordKey,
  saveRecords,
  getRecords,
  setMenus,
  getMenus,
  migrateLegacy,
  isFullFetched,
  markFullFetched,
} from "./recordstore.js"

// 首次加载时把旧的单文件 records.json 迁移到分文件结构(幂等)
migrateLegacy()

/** 记录分类 -> 菜单类型: 1=补给 4=道具 */
const MENU_TYPE = { gacha: 1, material: 4 }

/**
 * 拉取某分类下的记录
 * 同一次补给(同一时间)可能获得多个相同物品, 因此不能仅按「时间+内容」去重,
 * 需附加该组合在同批次内的出现序号(|#n), 否则重复物品会被误删。
 * @param {boolean} full 全量: 忽略本地已存, 扫到接口越界重复为止; 否则增量
 * @returns {Promise<Array<{key,item}>>} 新增记录
 */
async function fetchIncremental(api, category, type, existingKeys, full = false, maxPages = 2000) {
  const list = []
  const seen = full ? new Set() : new Set(existingKeys) // 全量时忽略本地已存
  const occ = new Map()
  for (let page = 1; page <= maxPages; page++) {
    let data
    if (category === "gacha") data = await api.gacha(type, page, 10)
    else if (category === "material") data = await api.material(type, page, 10)
    else data = await api.hcoin(type, page, 10)

    const arr = data?.list || []
    if (!arr.length) break

    let fresh = 0
    for (const r of arr) {
      const base = recordKey(r.item || [])
      const n = occ.get(base) || 0
      occ.set(base, n + 1)
      const key = `${base}|#${n}`
      if (seen.has(key)) continue
      // 兼容旧数据: 旧 key 无序号, 视为该组合的第 0 条
      if (n === 0 && seen.has(base)) {
        seen.add(key)
        continue
      }
      seen.add(key)
      list.push({ key, item: r.item || [] })
      fresh++
    }
    // 本页无新数据(接口越界重复或全部已存), 或本页不满 -> 结束
    if (fresh === 0 || arr.length < 10) break
    await new Promise(r => setTimeout(r, 120))
  }
  return list
}

/**
 * 更新某分类(补给/道具)的全部子类型记录
 * @returns {Promise<Array<{type,label,added,total}>>}
 */
export async function updateRecords(api, uid, category) {
  const menuType = MENU_TYPE[category]
  const menus = (await api.menus(menuType)) || []
  setMenus(uid, category, menus)

  // 首次(或迁移后)全量抓取, 之后增量
  const full = !isFullFetched(uid, category)
  const result = []
  for (const m of menus) {
    const type = m.type
    const existing = getRecords(uid, category, type)
    const existingKeys = new Set(existing.map(r => r.key))
    const fresh = await fetchIncremental(api, category, type, existingKeys, full)
    const { added, total } = saveRecords(uid, category, type, fresh)
    result.push({ type, label: m.label, added, total })
  }
  markFullFetched(uid, category)
  return result
}

/**
 * 读取本地某分类的记录(按子类型分组)
 * @returns {Array<{type,label,records}>}
 */
export function collectRecords(uid, category) {
  const menus = getMenus(uid, category)
  const result = []
  for (const m of menus) {
    const type = String(m.type)
    result.push({ type, label: m.label, records: getRecords(uid, category, type) })
  }
  return result
}
