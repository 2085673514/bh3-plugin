import fs from 'node:fs'
import path from 'node:path'
import { fetchWithRetry } from './http.js'
import { writeJsonAtomic } from './jsonFile.js'

const WIKI_BASE = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki'
/** 米游社图鉴搜索接口每页固定 15 条，翻页与切片都以它为准 */
export const WIKI_PAGE_SIZE = 15

const SEARCH_TTL_MS = 5 * 60 * 1000
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_LIMIT = 400
const wikiCache = new Map()

/** 带 TTL 的请求缓存；同一个 key 并发请求会复用同一个 Promise */
function withCache(key, ttlMs, loader) {
  const now = Date.now()
  const hit = wikiCache.get(key)
  if (hit) {
    if (hit.pending) return hit.promise
    if (now - hit.ts < ttlMs) {
      // 命中即刷新 LRU 次序：热点条目不因为插入得早而被先淘汰
      wikiCache.delete(key)
      wikiCache.set(key, hit)
      return hit.promise
    }
    wikiCache.delete(key)
  }
  const promise = loader()
    .then(value => {
      wikiCache.set(key, { promise: Promise.resolve(value), ts: Date.now() })
      return value
    })
    .catch(error => {
      wikiCache.delete(key)
      throw error
    })
  wikiCache.set(key, { promise, ts: now, pending: true })
  if (wikiCache.size > CACHE_LIMIT) {
    for (const staleKey of wikiCache.keys()) {
      wikiCache.delete(staleKey)
      if (wikiCache.size <= CACHE_LIMIT / 2) break
    }
  }
  return promise
}

async function wikiGet(path, params = {}) {
  params.app_sn = 'bh3_wiki'
  const query = Object.keys(params)
    .map(key => `${key}=${encodeURIComponent(params[key])}`)
    .join('&')
  let res = null
  try {
    res = await fetchWithRetry(`${WIKI_BASE}${path}?${query}`, {}, { timeoutMs: 15000, retries: 1 })
  } catch (error) {
    throw new Error(`图鉴接口连接失败：${error.message}`)
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    throw new Error('图鉴接口返回异常')
  }
  if (!json || Number(json.retcode) !== 0) {
    throw new Error(json?.message || '图鉴接口异常')
  }
  return json.data
}

export async function wikiSearch(keyword = '', page = 1) {
  const data = await withCache(`search:${keyword}:${page}`, SEARCH_TTL_MS, () =>
    wikiGet('/v1/search/content', { keyword, page }))
  const list = (data?.list || []).map(item => ({
    id: item.id,
    title: item.title,
    summary: item.summary || '',
    icon: item.icon || '',
    channel: item.channels?.[0]?.name || '',
    parent: item.channels?.[0]?.parent?.name || '',
    bbs_url: item.bbs_url || '',
    tags: parseWikiTags(item.ext || ''),
  }))
  return { list, total: Number(data?.total) || list.length }
}

export async function wikiDetail(contentId) {
  const data = await withCache(`detail:${contentId}`, DETAIL_TTL_MS, () =>
    wikiGet('/v1/content/info', { content_id: contentId }))
  const content = data?.content || {}
  return {
    id: content.id,
    title: content.title,
    icon: content.icon || '',
    summary: content.summary || '',
    contents: Array.isArray(content.contents) ? content.contents : [],
    bbs_url: content.bbs_url || '',
  }
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractDataBlocks(html = '') {
  const blocks = []
  const regex = /data-data="([^"]*)"/g
  let match = null
  while ((match = regex.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1])
      const parsed = JSON.parse(decoded)
      if (Array.isArray(parsed)) {
        blocks.push(...parsed)
      } else {
        blocks.push(parsed)
      }
    } catch {
      // ignore malformed blocks
    }
  }
  return blocks
}

export function formatWikiDetail(detail = {}) {
  const lines = []
  if (detail.title) {
    lines.push(`=== ${detail.title} ===`)
  }
  if (detail.summary) {
    lines.push(stripHtml(detail.summary).slice(0, 200))
  }

  const blocks = []
  for (const section of detail.contents || []) {
    blocks.push(...extractDataBlocks(section.text || ''))
  }

  const fields = []
  const skills = []
  for (const block of blocks) {
    const data = block.data || {}
    const tmpl = String(block.tmplKey || '')
    const part = String(block.partKey || '')
    if (part === 'basicIntroduction' && Array.isArray(data.mainFields)) {
      for (const field of data.mainFields) {
        if (field.nameL && field.valueL) fields.push(`${field.nameL}：${stripHtml(field.valueL)}`)
        if (field.nameR && field.valueR) fields.push(`${field.nameR}：${stripHtml(field.valueR)}`)
      }
    } else if (['weapon', 'stigmata'].includes(tmpl) && Array.isArray(data.attr)) {
      for (const attr of data.attr) {
        if (attr.key && attr.value) {
          skills.push(`${attr.key}：${stripHtml(attr.value)}`)
        }
      }
    } else if (part === 'main' && Array.isArray(data.skills)) {
      for (const skill of data.skills) {
        if (skill.name && skill.value) skills.push(`${skill.name}：${stripHtml(skill.value)}`)
      }
    } else if (data.mainFields && Array.isArray(data.mainFields)) {
      for (const field of data.mainFields) {
        if (field.nameL && field.valueL) fields.push(`${field.nameL}：${stripHtml(field.valueL)}`)
        if (field.nameR && field.valueR) fields.push(`${field.nameR}：${stripHtml(field.valueR)}`)
      }
    }
  }

  if (fields.length > 0) {
    lines.push('', '—— 基础信息 ——')
    lines.push(...fields.slice(0, 12))
  }
  if (skills.length > 0) {
    lines.push('', '—— 技能/属性 ——')
    lines.push(...skills.slice(0, 10))
  }

  if (lines.length <= 1) {
    const text = (detail.contents || [])
      .map(section => `【${section.name || '正文'}】\n${stripHtml(section.text || '').slice(0, 600)}`)
      .join('\n\n')
    if (text) lines.push(text.slice(0, 1500))
  }

  return lines.join('\n')
}

/** 从 ext 字段中提取筛选标签：{"c_18":{"filter":{"text":"[\"属性/异能\", ...]"}}} */
export function parseWikiTags(ext = '') {
  const tags = []
  try {
    const parsed = JSON.parse(ext)
    for (const value of Object.values(parsed || {})) {
      const text = value?.filter?.text
      if (!text) continue
      try {
        for (const tag of JSON.parse(text)) {
          const short = String(tag).split('/').pop().trim()
          if (short && !tags.includes(short)) tags.push(short)
        }
      } catch {
        // ignore malformed tag list
      }
    }
  } catch {
    // ignore malformed ext
  }
  return tags.slice(0, 8)
}

/** 收集正文里所有 data-data 数据块 */
function collectBlocks(detail = {}) {
  const blocks = []
  for (const section of detail.contents || []) {
    for (const block of extractDataBlocks(section.text || '')) {
      blocks.push({ ...block, sectionName: section.name || '' })
    }
  }
  return blocks
}

function clip(text = '', max = 220) {
  const value = stripHtml(text)
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 圣痕页面里的「圣痕技能 / 套装技能」是静态 HTML 表格，需要单独抽取 */
function extractStigmataSkills(html = '') {
  const result = { piece: null, set: [] }
  const tableRe = /<h2>\s*(圣痕技能|套装技能)\s*<\/h2>([\s\S]*?)<\/table>/g
  let table
  while ((table = tableRe.exec(html))) {
    const rows = []
    const rowRe = /<td class="h3">([\s\S]*?)<\/td>[\s\S]*?<td[^>]*class="[^"]*rich-text[^"]*">([\s\S]*?)<\/td>/g
    let row
    while ((row = rowRe.exec(table[2]))) {
      const name = stripHtml(row[1]).replace(/\s+/g, ' ').trim()
      const desc = stripHtml(row[2])
      if (name && desc) rows.push({ name, desc })
    }
    if (table[1] === '圣痕技能') {
      result.piece = rows[0] || null
    } else {
      result.set = rows
    }
  }
  return result
}

/**
 * 把图鉴详情解析成适合排版的结构
 * @returns {{kind:string, title:string, icon:string, tags:string[], rarity:number, fields:object[],
 *   attrs:object[], hexagon:object[], skills:object[], relatives:object[], gains:object[],
 *   desc:string, sections:object[]}}
 */
export function parseWikiDetail(detail = {}, options = {}) {
  const blocks = collectBlocks(detail)
  const find = (tmpl, part) => blocks.find(block => block.tmplKey === tmpl && block.partKey === part)?.data || null
  const findAll = (tmpl, part) => blocks.filter(block => block.tmplKey === tmpl && block.partKey === part).map(block => block.data || {})
  const tags = options.tags?.length ? options.tags : parseWikiTags(detail.ext || '')

  const base = {
    id: detail.id || options.id || '',
    title: detail.title || '',
    icon: detail.icon || '',
    tags,
    rarity: 0,
    kind: 'generic',
    fields: [],
    attrs: [],
    hexagon: [],
    skills: [],
    relatives: [],
    gains: [],
    desc: '',
    pieceSkill: null,
    setSkills: [],
    sections: [],
  }

  const valkyrie = find('valkyrie', 'basicIntroduction')
  const weapon = find('weapon', 'info')
  const stigmata = find('stigmata', 'main')

  if (valkyrie) {
    base.kind = 'valkyrie'
    base.icon = valkyrie.avatar || base.icon
    for (const field of valkyrie.mainFields || []) {
      if (field.nameL && field.valueL) base.fields.push({ name: field.nameL, value: clip(field.valueL) })
      if (field.nameR && field.valueR) base.fields.push({ name: field.nameR, value: clip(field.valueR) })
    }
    for (const field of valkyrie.subFields || []) {
      if (field.name && field.value) base.fields.push({ name: field.name, value: clip(field.value) })
    }
    base.hexagon = (valkyrie.hexagon || []).map(item => ({
      key: item.key || '',
      value: Math.max(0, Math.min(100, Number(item.value) || 0)),
      level: item.level || '',
    }))
    const skillBlock = find('valkyrie', 'skill') || {}
    for (const group of skillBlock.items || []) {
      for (const skill of group.list || []) {
        if (!skill.name) continue
        base.skills.push({ name: skill.name, icon: skill.icon || '', desc: clip(skill.desc, 180) })
      }
    }
    const rank = tags.find(tag => tag === 'S' || tag === 'A' || tag === 'B')
    if (rank) base.rank = rank
  } else if (weapon) {
    base.kind = 'weapon'
    base.icon = weapon.icon || base.icon
    base.rarity = Number(weapon.starValue) || 0
    base.desc = clip(weapon.desc, 320)
    base.attrs = (weapon.attr || []).map(item => ({ name: item.key || '', value: String(item.value ?? '') }))
    const skillBlock = find('weapon', 'skill') || {}
    base.skills = (skillBlock.attr || []).map(item => ({
      name: item.key || '',
      icon: '',
      desc: clip(item.value, 220),
    }))
  } else if (stigmata) {
    base.kind = 'stigmata'
    base.icon = stigmata.avatar || base.icon
    // 圣痕标签形如「五星」「四星」，需要把中文数字转成星级
    const CHINESE_NUMBER = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
    const starTag = tags.find(tag => /星$/.test(tag))
    const starChar = starTag?.match(/([一二三四五六]|\d)/)?.[1]
    base.rarity = starChar ? Number(CHINESE_NUMBER[starChar] || starChar) || 0 : 0
    for (const field of stigmata.subFields || []) {
      if (field.name && field.value) base.fields.push({ name: field.name, value: clip(field.value, 260) })
    }
    base.relatives = (stigmata.relatives || [])
      .filter(item => item?.name && item.name !== '无')
      .map(item => ({
        name: item.name,
        icon: item.icon || '',
        id: String(item.url || '').match(/\/content\/(\d+)\//)?.[1] || '',
      }))
    const attrBlock = find('stigmata', 'basicAttr') || {}
    base.attrs = (attrBlock.attr || []).map(item => ({
      name: item.key || '',
      value: String(item.value ?? ''),
      score: item.score,
    }))
    const skillHtml = (detail.contents || []).map(section => section.text || '').join('\n')
    const skills = extractStigmataSkills(skillHtml)
    base.pieceSkill = skills.piece
    base.setSkills = skills.set
    // 圣痕技能单独成块展示，避免和基础信息里的同名字段重复
    const skillFieldIndex = base.fields.findIndex(field => field.name === '圣痕技能')
    if (skillFieldIndex >= 0) {
      if (!base.pieceSkill) base.pieceSkill = { name: '', desc: base.fields[skillFieldIndex].value }
      base.fields.splice(skillFieldIndex, 1)
    }
  }

  // 通用块：获取方式（「圣痕技能 / 套装技能」也是 gainMethod 结构，要排除）
  for (const gainBlock of findAll('general', 'gainMethod')) {
    if (/技能/.test(String(gainBlock.title || ''))) continue
    for (const item of gainBlock.gainMethod || []) {
      if (item.key) base.gains.push({ name: item.key, value: clip(item.value, 160) })
    }
  }

  if (!base.desc) {
    base.desc = clip(detail.summary || '', 320)
  }
  // 简介和标题重复时没有信息量，直接隐藏该面板
  if (base.desc === base.title) base.desc = ''

  // 保底：没有专门块时，把正文段落放进 sections
  if (base.kind === 'generic' || (base.fields.length === 0 && base.skills.length === 0)) {
    for (const section of detail.contents || []) {
      const text = clip(section.text || '', 500)
      if (!text) continue
      const name = /^页签\d+$/.test(section.name || '') ? '' : section.name || '正文'
      base.sections.push({ name, text })
      if (base.sections.length >= 3) break
    }
  }

  base.skillsTotal = base.skills.length
  base.skills = base.skills.slice(0, 8)
  base.fields = base.fields.slice(0, 8)
  base.tags = tags.slice(0, 6)
  return base
}

const KIND_LABEL = { valkyrie: '女武神', weapon: '武器', stigmata: '圣痕' }

/** 图鉴搜索结果 → 列表卡片数据 */
export function buildWikiListCard(results = [], { keyword = '', type = '', page = 1, total = 0, pageSize = 15 } = {}) {
  const pages = Math.max(1, Math.ceil((Number(total) || results.length) / pageSize))
  return {
    keyword,
    typeLabel: String(type || '').replace(/图鉴$/, ''),
    page,
    pages,
    total: Number(total) || results.length,
    count: results.length,
    items: results.map((item, index) => ({
      index: index + 1,
      id: item.id,
      title: item.title || '',
      icon: item.icon || '',
      channel: item.channel || '',
      parent: item.parent || '',
    })),
    footer: pages > 1
      ? `数据来自米游社图鉴 · 翻页：#崩坏3图鉴 ${keyword} ${Math.min(page + 1, pages)} · 详情：#崩坏3图鉴详情 <编号>`
      : '数据来自米游社图鉴 · 详情：#崩坏3图鉴详情 <编号>',
  }
}

/** 图鉴详情 → 详情卡片数据 */
export function buildWikiDetailCard(detail = {}, options = {}) {
  const parsed = parseWikiDetail(detail, options)
  parsed.kindLabel = KIND_LABEL[parsed.kind] || options.channel || '图鉴'
  parsed.channel = options.channel || ''
  parsed.parent = options.parent || ''
  parsed.stars = parsed.rarity > 0 ? '★'.repeat(parsed.rarity) : ''
  // 已经有星级时，去掉重复的「五星」类标签
  if (parsed.stars) parsed.tags = parsed.tags.filter(tag => !/^[一二三四五六]星$/.test(tag))
  parsed.footer = parsed.channel ? `数据来自米游社图鉴 · ${parsed.channel}` : '数据来自米游社图鉴'
  return parsed
}

/** 本地的圣痕套装索引：记录「套装名 -> 上/中/下 id」，用于按套装名直接搜索 */
const SET_INDEX_FILE = path.join(process.cwd(), 'data', 'bh3', 'wiki-sets.json')
let setIndexCache = null

function readSetIndex() {
  if (setIndexCache) return setIndexCache
  try {
    setIndexCache = JSON.parse(fs.readFileSync(SET_INDEX_FILE, 'utf8')) || {}
  } catch {
    setIndexCache = {}
  }
  return setIndexCache
}

/** 每看到一套圣痕就顺手记下来，下次可以直接按套装名搜 */
export function rememberWikiSet(setName, pieces = []) {
  const name = String(setName || '').trim()
  if (!name || pieces.length < 2) return
  const index = readSetIndex()
  const entry = index[name] || { name, pieces: {}, updatedAt: '' }
  for (const piece of pieces) {
    const position = piece?.position
    const id = piece?.id
    if (position && id) entry.pieces[position] = String(id)
  }
  entry.updatedAt = new Date().toISOString()
  index[name] = entry
  try {
    writeJsonAtomic(SET_INDEX_FILE, index)
  } catch (error) {
    globalThis.logger?.warn?.(`[bh3] 保存圣痕套装索引失败: ${error.message}`)
  }
}

/** 按套装名查本地索引，支持「倾城古韵」「倾城古韵套装」两种写法 */
export function findWikiSet(keyword = '') {
  const query = String(keyword || '').trim().replace(/套装$/, '')
  if (!query) return null
  const index = readSetIndex()
  const names = Object.keys(index)
  const name = names.find(item => item === query) || names.find(item => item.includes(query) || query.includes(item))
  return name ? index[name] : null
}

export { stripHtml }

/** 圣痕位置：上位 / 中位 / 下位 */
export function stigmaPosition(parsed = {}) {
  const field = (parsed.fields || []).find(item => item.name === '位置')
  const match = String(field?.value || '').match(/^(上|中|下)/)
  return match ? match[1] : ''
}

/** 圣痕所属套装名（去掉「套装」后缀） */
export function stigmaSetName(parsed = {}) {
  const field = (parsed.fields || []).find(item => item.name === '所属套装')
  return field ? String(field.value || '').replace(/套装$/, '') : ''
}

/** 把上/中/下圣痕合成一张套装卡（缺件时留占位，支持 2 件套） */
export function buildWikiSetCard(pieces = [], { setName = '' } = {}) {
  const order = { 上: 0, 中: 1, 下: 2 }
  const POSITIONS = ['上', '中', '下']
  const sorted = pieces.slice().sort((a, b) => (order[stigmaPosition(a)] ?? 9) - (order[stigmaPosition(b)] ?? 9))
  const first = sorted[0] || {}
  const tags = []
  for (const piece of sorted) {
    for (const tag of piece.tags || []) {
      if (/^(上位|中位|下位|圣痕套装)$/.test(tag)) continue
      if (!tags.includes(tag)) tags.push(tag)
    }
  }
  const rarity = sorted.reduce((max, piece) => Math.max(max, Number(piece.rarity) || 0), 0)
  const totalOf = name => sorted.reduce((sum, piece) => {
    const attr = (piece.attrs || []).find(item => item.name === name)
    return sum + (Number(attr?.value) || 0)
  }, 0)
  const fieldOf = (piece, name) => (piece.fields || []).find(item => item.name === name)?.value || ''
  // 同一套装的套装技能是共用的，取任意一件的即可
  const setSkills = sorted.map(piece => piece.setSkills || []).find(list => list.length > 0) || []
  const count = sorted.length
  const slots = POSITIONS.map(position => {
    const piece = sorted.find(item => stigmaPosition(item) === position)
    return {
      position,
      missing: !piece,
      title: piece?.title || '',
      character: String(piece?.title || '').split(/[·・]/)[0].trim(),
      icon: piece?.icon || '',
      attrs: piece?.attrs || [],
      subTag: piece ? fieldOf(piece, '单件tag') : '',
      setTag: piece ? fieldOf(piece, '套装tag') : '',
      skill: piece ? piece.pieceSkill?.desc || fieldOf(piece, '圣痕技能') : '',
    }
  })
  const gains = []
  for (const piece of sorted) {
    for (const gain of piece.gains || []) {
      if (gain.name && !gains.some(item => item.name === gain.name && item.value === gain.value)) {
        gains.push(gain)
      }
    }
  }
  return {
    kindLabel: '圣痕套装',
    title: setName || stigmaSetName(first) || first.title || '',
    icon: first.icon || '',
    stars: rarity > 0 ? '★'.repeat(rarity) : '',
    tags: tags.slice(0, 8),
    count,
    slots,
    hasPieceSkill: slots.some(slot => slot.skill),
    gains,
    totalsLabel: `${count} 件合计`,
    setSkills: setSkills.map((skill, index) => ({
      name: skill.name,
      desc: skill.desc,
      label: index === 0 ? '2 件套' : '3 件套',
      active: index === 0 ? count >= 2 : count >= 3,
    })),
    totals: ['生命', '攻击', '防御', '会心'].map(name => ({ name, value: totalOf(name) })),
    footer: `数据来自米游社图鉴 · ${count} 件套`,
  }
}
