import {
  recordKey,
  replaceRecords,
  getRecords,
  setMenus,
  getMenus,
  listRecordTypes,
  labelOf,
  migrateLegacy,
  markFullFetched,
} from "./recordstore.js"

// 首次加载时把旧的单文件 records.json 迁移到分文件结构(幂等)
migrateLegacy()

/** 记录分类 -> 菜单类型: 1=补给 4=道具 */
const MENU_TYPE = { gacha: 1, material: 4 }

/**
 * 拉取某类型下的全部记录（从第 1 页扫到空页）。
 *
 * 为什么每次都全量：接口是 page/size 的偏移分页，新记录会顶到前面，同一页
 * 每次返回的内容会整体错位。用「增量 + |#n 序号」去合并时，同一条记录在不同
 * 批次的序号可能不同，于是被当成新记录重复写入，抽数越攒越多（会出现 64 抽
 * 这种超过硬保底的不可能数字）。全量重扫一遍、在单次遍历里编序号就不会错位。
 *
 * 同一次补给(同一时间)可能获得多个相同物品，所以不能只按「时间+内容」去重，
 * 仍需附加该组合在本次遍历中的出现序号(|#n)。
 * @returns {Promise<Array<{key,item}>>}
 */
async function fetchAll(api, category, type, maxPages = 80) {
  const list = []
  const occ = new Map()
  for (let page = 1; page <= maxPages; page += 1) {
    let data
    if (category === "gacha") data = await api.gacha(type, page, 10)
    else if (category === "material") data = await api.material(type, page, 10)
    else data = await api.hcoin(type, page, 10)

    const arr = data?.list || []
    if (!arr.length) break
    for (const r of arr) {
      const base = recordKey(r.item || [])
      const n = occ.get(base) || 0
      occ.set(base, n + 1)
      list.push({ key: `${base}|#${n}`, item: r.item || [] })
    }
    if (arr.length < 10) break
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

  const result = []
  for (const m of menus) {
    const type = m.type
    const fetched = await fetchAll(api, category, type)
    const { added, total } = replaceRecords(uid, category, type, fetched)
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
  const merged = new Map()
  for (const m of getMenus(uid, category)) {
    const type = String(m.type)
    merged.set(type, { type, label: m.label || labelOf(category, type) })
  }
  // 接口只返回当前开放的卡池；已下架卡池的记录仍在本地，不能被菜单漏掉
  for (const type of listRecordTypes(uid, category)) {
    if (!merged.has(type)) merged.set(type, { type, label: labelOf(category, type) })
  }
  return [...merged.values()]
    .sort((a, b) => Number(a.type) - Number(b.type))
    .map(m => ({ type: m.type, label: m.label, records: getRecords(uid, category, m.type) }))
}
