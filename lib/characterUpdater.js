// 崩坏3 女武神数据库：从米游社公开图鉴抓取，写入 data/characters.json
// 支持启动后自动更新（scheduleCharacterAutoUpdate）与手动更新（npm run update:data / #崩坏3更新角色库）
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { reloadCharacters } from './characters.js'

const DEFAULT_DATA_FILE = fileURLToPath(new URL('../data/characters.json', import.meta.url))
// 可用 BH3_CHARACTER_DATA_FILE 指向其它路径（测试或自定义存放位置）
const DATA_FILE = process.env.BH3_CHARACTER_DATA_FILE
  ? path.resolve(process.env.BH3_CHARACTER_DATA_FILE)
  : DEFAULT_DATA_FILE

const WIKI_BASE = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki'

/** 抓取数量低于该值时视为异常，不覆盖现有数据 */
const MIN_CHARACTERS = 80
/** 数据库超过该天数未更新时，启动后自动重新抓取 */
const MAX_AGE_DAYS = Number(process.env.BH3_CHARACTER_MAX_AGE_DAYS) || 7
/** 启动后延迟多久开始检查，避免和 Bot 启动抢资源 */
const STARTUP_DELAY_MS = Number(process.env.BH3_CHARACTER_STARTUP_DELAY_MS) || 10 * 1000
/** 运行期间复查周期（长时间不重启也能自动更新） */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20 * 1000
const REQUEST_GAP_MS = 120

/** 图鉴里表示「没有别名」的占位文本，不应参与匹配 */
const PLACEHOLDER_ALIASES = new Set(['暂无', '无', '无别名', '-', '--', '—', '——'])

const ELEMENT_MAP = [
  [/火焰|火伤/, '火'],
  [/冰冻|冰霜|冰伤/, '冰'],
  [/雷电|雷伤/, '雷'],
  [/物理/, '物理'],
  [/量子/, '量子'],
  [/虚数/, '虚数'],
  [/星尘/, '星尘'],
]

let running = false

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function detectElement(roleText = '') {
  const text = String(roleText || '')
  const pair = ELEMENT_MAP.find(([regex]) => regex.test(text))
  return pair ? pair[1] : ''
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

async function wikiGet(wikiPath, params = {}) {
  params.app_sn = 'bh3_wiki'
  const query = Object.keys(params)
    .map(key => `${key}=${encodeURIComponent(params[key])}`)
    .join('&')
  const json = await fetchJson(`${WIKI_BASE}${wikiPath}?${query}`)
  if (!json || Number(json.retcode) !== 0) {
    throw new Error(`wiki ${wikiPath} 失败: ${json?.message || 'unknown'}`)
  }
  return json.data
}

function extractBlocks(html = '') {
  const blocks = []
  const regex = /data-data="([^"]*)"/g
  let match = null
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(decodeURIComponent(match[1]))
      if (Array.isArray(parsed)) blocks.push(...parsed)
      else blocks.push(parsed)
    } catch {
      // ignore malformed blocks
    }
  }
  return blocks
}

function parseFilters(ext = '') {
  const result = {}
  try {
    const parsed = JSON.parse(ext || '{}')
    const text = parsed.c_18?.filter?.text || '[]'
    const filters = JSON.parse(text)
    for (const filter of filters) {
      const [key, value] = String(filter).split('/')
      if (key === '属性') result.attribute = value
      if (key === '角色') result.character = value
      if (key === '初始阶级') result.rarity = value
      if (key === '装甲特性') result.trait = value
    }
  } catch {
    // ignore
  }
  return result
}

function pickShowcase(contents = [], avatar = '') {
  let portrait = ''
  let background = ''
  for (const section of contents) {
    for (const block of extractBlocks(section.text || '')) {
      if (String(block.partKey || '') !== 'costume') continue
      const items = Array.isArray(block.data?.items) ? block.data.items : []
      for (const item of items) {
        const img = String(item.img || '')
        const name = String(item.name_ || '')
        if (!img) continue
        if (/横版|horizontal/i.test(name)) {
          background = background || img
        } else if (/竖版|vertical/i.test(name)) {
          portrait = portrait || img
        }
      }
      if (!portrait) {
        const first = items.find(item => item.img)
        portrait = first ? String(first.img) : ''
      }
      if (!background) {
        const second = items.find((item, index) => index > 0 && item.img)
        background = second ? String(second.img) : (items[0]?.img ? String(items[0].img) : '')
      }
      if (portrait || background) return { portrait, background }
    }
  }
  if (!portrait) portrait = avatar
  return { portrait, background }
}

function parseEvaluation(contents = []) {
  const result = {
    aliases: [],
    weaponType: '',
    role: '',
    attribute: '',
    avatar: '',
    hexagon: {},
    baseAttack: null,
    life: null,
    defense: null,
  }
  for (const section of contents) {
    for (const block of extractBlocks(section.text || '')) {
      const data = block.data || {}
      const part = String(block.partKey || '')
      if (part === 'basicIntroduction') {
        if (data.avatar) result.avatar = String(data.avatar)
        for (const field of Array.isArray(data.mainFields) ? data.mainFields : []) {
          if (field.nameL === '别名' && field.valueL) {
            result.aliases = String(field.valueL)
              .split(/[、，,;；]/)
              .map(item => item.trim())
              .filter(Boolean)
          }
          if (field.nameL === '角色属性' && field.valueL) result.attribute = String(field.valueL)
          if (field.nameL === '武器类型' && field.valueL) result.weaponType = String(field.valueL)
          if (field.nameL === '角色定位' && field.valueL) result.role = String(field.valueL)
        }
        for (const item of Array.isArray(data.hexagon) ? data.hexagon : []) {
          if (item.key) result.hexagon[item.key] = item.value
        }
      }
      if (part === 'advanceData' && Array.isArray(data.advanceData) && data.advanceData.length > 0) {
        const last = data.advanceData[data.advanceData.length - 1]
        result.baseAttack = Number(last.attack) || null
        result.life = Number(last.life) || null
        result.defense = Number(last.defense) || null
      }
    }
  }
  return result
}

function cleanAliases(list = []) {
  const seen = new Set()
  const result = []
  for (const raw of list) {
    const alias = String(raw || '').trim()
    if (!alias || PLACEHOLDER_ALIASES.has(alias) || seen.has(alias)) continue
    seen.add(alias)
    result.push(alias)
  }
  return result
}

/** 读取当前数据库的生成时间与条目数 */
export function readCharacterMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    const list = Array.isArray(raw.characters) ? raw.characters : []
    const generatedAt = raw.generatedAt || ''
    const time = generatedAt ? new Date(generatedAt).getTime() : 0
    const ageDays = time ? (Date.now() - time) / 86400000 : Infinity
    return { count: list.length, generatedAt, ageDays }
  } catch {
    return { count: 0, generatedAt: '', ageDays: Infinity }
  }
}

async function fetchCharacters({ logger } = {}) {
  const listData = await wikiGet('/v1/home/content/list', { channel_id: 18 })
  const items = []
  for (const section of listData?.list || []) {
    for (const item of section.list || []) {
      items.push(item)
    }
  }
  if (items.length < MIN_CHARACTERS) {
    throw new Error(`图鉴目录条目异常（${items.length}），已放弃本次更新`)
  }
  logger?.info?.(`[bh3] 图鉴条目 ${items.length}，开始抓取角色详情...`)

  const characters = []
  let failed = 0
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const filters = parseFilters(item.ext || '')
    try {
      const data = await wikiGet('/v1/content/info', { content_id: item.content_id })
      const content = data?.content || {}
      const evaluation = parseEvaluation(content.contents || [])
      const showcase = pickShowcase(content.contents || [], evaluation.avatar)
      const name = String(content.title || item.title || '')
      const element = detectElement(evaluation.role || filters.trait)
      characters.push({
        id: Number(item.content_id),
        name,
        aliases: cleanAliases([...evaluation.aliases, filters.character, name]),
        character: filters.character || '',
        attribute: evaluation.attribute || filters.attribute || '',
        element,
        weaponType: evaluation.weaponType || '',
        role: evaluation.role || '',
        rarity: filters.rarity || '',
        icon: String(item.icon || ''),
        avatar: evaluation.avatar || '',
        portrait: showcase.portrait,
        background: showcase.background,
        baseAttack: evaluation.baseAttack,
        life: evaluation.life,
        defense: evaluation.defense,
        hexagon: evaluation.hexagon,
      })
      if ((index + 1) % 25 === 0) {
        logger?.info?.(`[bh3] 已抓取 ${index + 1}/${items.length}`)
      }
    } catch (error) {
      failed++
      logger?.debug?.(`[bh3] 跳过 ${item.title || item.content_id}: ${error.message}`)
    }
    await sleep(REQUEST_GAP_MS)
  }
  return { characters, failed }
}

/**
 * 立即从米游社图鉴重新抓取并写入数据库。
 * 抓取结果过少或出错时保留原文件，不会把可用数据覆盖成空。
 */
export async function updateCharacterData({ logger = globalThis.logger } = {}) {
  if (running) {
    logger?.warn?.('[bh3] 角色数据库正在更新中，跳过本次请求')
    return { ok: false, reason: 'running', count: 0 }
  }
  running = true
  const startedAt = Date.now()
  try {
    logger?.info?.('[bh3] 开始更新角色数据库（米游社公开图鉴）...')
    const { characters, failed } = await fetchCharacters({ logger })
    if (characters.length < MIN_CHARACTERS) {
      throw new Error(`抓取结果过少（${characters.length}），保留原有数据`)
    }
    characters.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
    const generatedAt = new Date().toISOString()
    const tmpFile = `${DATA_FILE}.tmp`
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    fs.writeFileSync(tmpFile, JSON.stringify({ generatedAt, characters }, null, 2), 'utf8')
    fs.renameSync(tmpFile, DATA_FILE)
    // 同进程内立即生效，无需重启
    if (DATA_FILE === DEFAULT_DATA_FILE) reloadCharacters()
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    logger?.info?.(`[bh3] 角色数据库已更新：${characters.length} 名女武神，失败 ${failed} 个，耗时 ${seconds}s`)
    return { ok: true, count: characters.length, failed, generatedAt }
  } catch (error) {
    logger?.warn?.(`[bh3] 角色数据库更新失败，保留原有数据：${error.message}`)
    return { ok: false, reason: error.message, count: 0 }
  } finally {
    running = false
  }
}

/** 数据库缺失或超过 MAX_AGE_DAYS 未更新时才真正抓取 */
export async function ensureCharacterData({ logger = globalThis.logger } = {}) {
  const meta = readCharacterMeta()
  if (meta.count >= MIN_CHARACTERS && meta.ageDays < MAX_AGE_DAYS) {
    logger?.debug?.(`[bh3] 角色数据库仍可用（${meta.count} 名，${meta.ageDays.toFixed(1)} 天前更新），跳过自动更新`)
    return { ok: true, skipped: true, ...meta }
  }
  return updateCharacterData({ logger })
}

/**
 * 注册启动后自动更新：延迟 STARTUP_DELAY_MS 检查一次，之后每天复查。
 * 也可用环境变量 BH3_CHARACTER_AUTO_UPDATE=0 关闭。
 */
export function scheduleCharacterAutoUpdate({ logger = globalThis.logger } = {}) {
  const flag = String(process.env.BH3_CHARACTER_AUTO_UPDATE ?? '1').toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'off') {
    logger?.info?.('[bh3] 角色数据库自动更新已关闭（BH3_CHARACTER_AUTO_UPDATE=0）')
    return false
  }
  if (globalThis.__bh3CharacterAutoUpdate) return false
  globalThis.__bh3CharacterAutoUpdate = true

  const check = () => {
    ensureCharacterData({ logger }).catch(error => {
      logger?.warn?.(`[bh3] 角色数据库自动更新异常：${error.message}`)
    })
  }

  const timer = setTimeout(check, STARTUP_DELAY_MS)
  const interval = setInterval(check, CHECK_INTERVAL_MS)
  timer.unref?.()
  interval.unref?.()
  const meta = readCharacterMeta()
  logger?.info?.(
    `[bh3] 已启用角色数据库自动更新（当前 ${meta.count} 名，${Number.isFinite(meta.ageDays) ? `${meta.ageDays.toFixed(1)} 天前更新` : '无记录'}，超过 ${MAX_AGE_DAYS} 天自动刷新）`
  )
  return true
}
