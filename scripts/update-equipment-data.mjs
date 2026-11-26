/**
 * 从米游社崩坏3图鉴同步「武器 / 圣痕 / 女武神」的稀有度与图标。
 *
 * 背景：resources/bh3_rarity.json 与 resources/bh3_icons.json 是静态文件，
 * 新版本出了新装备后不会自动包含，抽卡记录里就会把 5★ 新装备显示成 3★。
 *
 * 用法（在插件目录下）：
 *   node scripts/update-equipment-data.mjs
 * 建议每个版本更新后跑一次；脚本会把图鉴里的最新条目合并进现有文件，
 * 已有但图鉴里暂时没有的条目会保留，不会丢数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES_DIR = path.join(ROOT, 'resources')
const RARITY_FILE = path.join(RES_DIR, 'bh3_rarity.json')
const ICONS_FILE = path.join(RES_DIR, 'bh3_icons.json')

const WIKI_BASE = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki'
const GAP_MS = 250

/**
 * 图鉴频道：18 女武神 / 19 圣痕 / 20 武器 / 218 协同者。
 * 协同者只同步图标（图鉴没有星级字段），补给记录里叫「白薇塔」之类的别名
 * 在 lib/mys/card.js 的 SYNERGY_ALIAS 里映射到图鉴名称。
 */
const CHANNELS = [
  { id: 18, group: 'characters', label: '女武神' },
  { id: 19, group: 'stigmata', label: '圣痕' },
  { id: 20, group: 'weapons', label: '武器' },
  { id: 218, group: 'synergy', label: '协同者', iconOnly: true },
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function wikiGet(wikiPath, params = {}) {
  const query = { app_sn: 'bh3_wiki', ...params }
  const qs = Object.keys(query)
    .map(key => `${key}=${encodeURIComponent(query[key])}`)
    .join('&')
  const res = await fetch(`${WIKI_BASE}${wikiPath}?${qs}`, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${wikiPath}`)
  const json = await res.json()
  if (!json || Number(json.retcode) !== 0) throw new Error(`wiki ${wikiPath} 失败: ${json?.message || 'unknown'}`)
  return json.data
}

/** 从 ext 里取出所有「分类/值」形式的标签 */
function parseFilters(ext = '') {
  const out = []
  try {
    const parsed = JSON.parse(ext || '{}')
    for (const block of Object.values(parsed)) {
      const text = block?.filter?.text
      if (!text) continue
      try {
        const list = JSON.parse(text)
        if (Array.isArray(list)) out.push(...list.map(String))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/** 武器星级：超限武器算 5★（与卡片里「5⭐武器」判定一致） */
function weaponRarity(filters = []) {
  const text = filters.join(' ')
  if (/超限武器/.test(text)) return 5
  if (/五星武器/.test(text)) return 5
  if (/四星武器/.test(text)) return 4
  if (/三星武器/.test(text)) return 3
  return 0
}

function stigmaRarity(filters = []) {
  const text = filters.join(' ')
  if (/圣痕星级\/五星/.test(text)) return 5
  if (/圣痕星级\/四星/.test(text)) return 4
  if (/圣痕星级\/三星/.test(text)) return 3
  return 0
}

function characterRarity(filters = []) {
  for (const filter of filters) {
    const [key, value] = String(filter).split('/')
    if (key === '初始阶级' && value) return value
  }
  return ''
}

async function fetchChannel(channel) {
  const data = await wikiGet('/v1/home/content/list', { channel_id: channel.id })
  const sections = data?.list || []
  const items = sections.flatMap(section => section.list || [])
  return items
    .map(item => ({
      name: String(item.title || item.name || '').trim(),
      icon: String(item.icon || '').trim(),
      rarity: channel.iconOnly
        ? ''
        : channel.group === 'weapons'
          ? weaponRarity(parseFilters(item.ext))
          : channel.group === 'stigmata'
            ? stigmaRarity(parseFilters(item.ext))
            : characterRarity(parseFilters(item.ext)),
    }))
    .filter(item => item.name)
}

const rarity = readJson(RARITY_FILE, { characters: {}, weapons: {}, stigmata: {} })
const icons = readJson(ICONS_FILE, { characters: {}, weapons: {}, stigmata: {}, synergy: {} })
for (const group of ['characters', 'weapons', 'stigmata', 'synergy']) {
  if (!icons[group]) icons[group] = {}
  if (group !== 'synergy' && !rarity[group]) rarity[group] = {}
}

const summary = []
for (const channel of CHANNELS) {
  const items = await fetchChannel(channel)
  let added = 0
  let updated = 0
  for (const item of items) {
    if (!channel.iconOnly && item.rarity) {
      const before = rarity[channel.group][item.name]
      if (before === undefined) added += 1
      else if (before !== item.rarity) updated += 1
      rarity[channel.group][item.name] = item.rarity
    } else if (channel.iconOnly) {
      if (!icons[channel.group][item.name]) added += 1
    }
    if (item.icon) icons[channel.group][item.name] = item.icon
  }
  summary.push(`${channel.label}: 图鉴 ${items.length} 条，新增 ${added}，修正 ${updated}`)
  await sleep(GAP_MS)
}

rarity.generatedAt = new Date().toISOString()
icons.generatedAt = rarity.generatedAt
// 保持仓库里原来的紧凑格式（单行 JSON），避免每次同步都产生上千行 diff
fs.writeFileSync(RARITY_FILE, JSON.stringify(rarity), 'utf8')
fs.writeFileSync(ICONS_FILE, JSON.stringify(icons), 'utf8')

console.log(summary.join('\n'))
console.log(
  `合计：女武神 ${Object.keys(rarity.characters).length} / 武器 ${Object.keys(rarity.weapons).length} / 圣痕 ${Object.keys(rarity.stigmata).length}`,
)
console.log('已写入 resources/bh3_rarity.json 与 resources/bh3_icons.json')
