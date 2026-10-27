import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const DATA_FILE = fileURLToPath(new URL('../data/characters.json', import.meta.url))

let cache = null
/** 归一化后的检索索引，懒构建；数据重载时一并失效 */
let index = null

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    cache = Array.isArray(parsed.characters) ? parsed.characters : []
  } catch {
    cache = []
  }
  index = null
  return cache
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase()
}

/**
 * 预先归一化名字与别名：此前每次查询都要对全部记录反复 toLowerCase，
 * 人物库 130+ 条时一次查询要做几百次字符串转换。
 */
function loadIndex() {
  if (index) return index
  index = load().map(item => ({
    item,
    name: normalize(item?.name),
    aliases: Array.isArray(item?.aliases) ? item.aliases.map(alias => normalize(alias)) : [],
  }))
  return index
}

export function getAllCharacters() {
  return load()
}

/** 数据库文件更新后调用，清掉内存缓存，下一次读取即为新数据 */
export function reloadCharacters() {
  cache = null
  index = null
  return load()
}

export function findCharacter(keyword = '') {
  const text = normalize(keyword)
  if (!text) return null
  const entries = loadIndex()
  const exactName = entries.find(entry => entry.name === text)
  if (exactName) return exactName.item
  const exactAlias = entries.find(entry => entry.aliases.includes(text))
  if (exactAlias) return exactAlias.item
  const nameHit = entries.find(entry => entry.name.includes(text))
  if (nameHit) return nameHit.item
  const aliasHit = entries.find(entry => entry.aliases.some(alias => alias.includes(text)))
  return aliasHit ? aliasHit.item : null
}

export function searchCharacters(keyword = '') {
  const text = normalize(keyword)
  if (!text) return []
  const entries = loadIndex()
  const exactName = entries.filter(entry => entry.name === text)
  const exactAlias = entries.filter(entry => entry.aliases.includes(text))
  const contains = entries.filter(entry =>
    entry.name.includes(text) || entry.aliases.some(alias => alias.includes(text))
  )
  const seen = new Set()
  return [...exactName, ...exactAlias, ...contains]
    .map(entry => entry.item)
    .filter(item => {
      if (seen.has(item?.id)) return false
      seen.add(item?.id)
      return true
    })
    .slice(0, 10)
}
