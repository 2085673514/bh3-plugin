/**
 * 崩坏3 公告来源：卡池 / 活动的起止时间。
 *
 * 米游社公告列表（不需要 Cookie）：
 *   https://api-takumi.mihoyo.com/post/wapi/getNewsList?gids=1&type=1|2
 * 详情：
 *   https://api-takumi.mihoyo.com/post/wapi/getPostFull?post_id=xxx
 *
 * 公告正文里通常写「【上架时间】11月6日12:00~11月26日04:00」「【开放时间】…」，
 * 这里把这些时间段抽出来，按标题分成「卡池」和「活动」。
 * 抓取失败时退回本地缓存，再失败退回 data/bh3/calendar.json（手动维护）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fetchWithRetry } from './http.js'

const NEWS_LIST = 'https://api-takumi.mihoyo.com/post/wapi/getNewsList'
const POST_FULL = 'https://api-takumi.mihoyo.com/post/wapi/getPostFull'
const CACHE_FILE = path.join(process.cwd(), 'data', 'bh3', 'calendar-cache.json')
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_POST_AGE_DAYS = 75
const CACHE_VERSION = 2
const DETAIL_BATCH = 15
const DETAIL_CONCURRENCY = 2
const DETAIL_GAP_MS = 320

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 miHoYoBBS/2.102.1',
  Referer: 'https://www.miyoushe.com/',
  'X-Requested-With': 'XMLHttpRequest',
}

let memoryCache = null
let inflight = null
// 被公告接口限流（retcode 1034）后，冷却期内不再抓详情，避免越抓越久
let throttledUntil = 0

const POOL_RE = /^【补给】|装备补给|跃升武装|跃升补给|精准补给|扩充补给|家园补给|服装补给/
const VERSION_NOTICE_RE = /(\d+\.\d+)\s*版本(?:维护通知|更新公告)/
const SKIP_RE = /封禁|处罚|问卷|修复|说明|防沉迷|举报|客服|下载|充值|周边|有奖|生日|已开奖|讨论|盖楼|抽奖|征集|开奖/

function plainText(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
}

function parseClock(text) {
  const m = String(text || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/**
 * 从公告正文里抽出时间段
 * 支持：
 *   11月6日12:00~11月26日04:00
 *   11月6日 12:00 - 11月26日 04:00
 *   2026/11/06 12:00 ~ 2026/11/26 04:00
 *   9.1版本更新后~11月26日04:00（用版本维护结束时间补全起点）
 * @param {string} text 纯文本正文
 * @param {Date} created 公告发布时间，用于补年份
 * @param {Record<string, Date>} anchors 版本号 -> 版本维护结束时间
 */
export function parseTimeRanges(text, created = new Date(), anchors = {}) {
  const stamp = date => `${date.getMonth() + 1}月${date.getDate()}日${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const createdText = stamp(created)
  const body = String(text || '')
    // 「9.1版本更新后」这类起点先替换成具体日期，交给下面的通用规则解析
    .replace(/(\d+\.\d+)\s*版本更新后/g, (all, version) => stamp(anchors[version] || created))
    .replace(/版本更新后/g, createdText)
  const results = []
  const baseYear = created.getFullYear()
  const baseMonth = created.getMonth() + 1

  const inferYear = month => (month < baseMonth - 6 ? baseYear + 1 : baseYear)

  // 1) 绝对日期：2026/11/06 12:00 ~ 2026/11/26 04:00
  const absRe = /(20\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*(\d{1,2}[:：]\d{2})?\s*[~～\-—至]\s*(?:20\d{2}\s*[/\-.]\s*)?(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*(\d{1,2}[:：]\d{2})?/g
  for (const m of body.matchAll(absRe)) {
    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), parseClock(m[4])?.hour ?? 12, parseClock(m[4])?.minute ?? 0)
    const endYear = Number(m[2]) > Number(m[5]) ? Number(m[1]) + 1 : Number(m[1])
    const end = new Date(endYear, Number(m[5]) - 1, Number(m[6]), parseClock(m[7])?.hour ?? 4, parseClock(m[7])?.minute ?? 0)
    if (end > start) results.push({ start, end })
  }

  // 2) 中文月日：11月6日12:00~11月26日04:00
  const cnRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}[:：]\d{2})?\s*[~～\-—至]\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日\s*(\d{1,2}[:：]\d{2})?/g
  for (const m of body.matchAll(cnRe)) {
    const startMonth = Number(m[1])
    const startDay = Number(m[2])
    const endMonth = Number(m[4] || m[1])
    const endDay = Number(m[5])
    const startClock = parseClock(m[3])
    const endClock = parseClock(m[6])
    const startYear = inferYear(startMonth)
    const endYear = endMonth < startMonth - 6 ? startYear + 1 : startYear
    const start = new Date(startYear, startMonth - 1, startDay, startClock?.hour ?? 12, startClock?.minute ?? 0)
    const end = new Date(endYear, endMonth - 1, endDay, endClock?.hour ?? 4, endClock?.minute ?? 0)
    if (end > start) results.push({ start, end })
  }

  return results
}

/** 公告标题 -> 展示名与分类 */
function classify(post) {
  const subject = String(post.subject || '')
  const name = subject
    .replace(/^【[^】]*】\s*/, '')
    .replace(/[丨|｜]/g, ' · ')
    .trim()
  const isPool = POOL_RE.test(subject)
  const type = /装备补给|跃升武装/.test(subject)
    ? '装备'
    : /角色补给|跃升补给/.test(subject)
      ? '角色'
      : /家园/.test(subject)
        ? '家园'
        : /服装补给/.test(subject)
          ? '服装'
          : /作战凭证/.test(subject)
            ? '凭证'
            : /累消/.test(subject)
              ? '累消'
              : /登录|签到/.test(subject)
                ? '福利'
                : isPool
                  ? '补给'
                  : '活动'
  return { name, isPool, type, subject }
}

async function fetchJson(url) {
  const res = await fetchWithRetry(url, { headers: HEADERS }, { timeoutMs: 15000, retries: 1 })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchNews(type) {
  const data = await fetchJson(`${NEWS_LIST}?gids=1&type=${type}&page_size=30`)
  if (Number(data.retcode) !== 0) throw new Error(data.message || '公告列表接口异常')
  return (data.data?.list || []).map(item => item.post).filter(Boolean)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 详情接口单独走一个小并发池：公告接口对浏览频率比较宽松，串行抓 30 篇要十几秒 */
async function fetchDetail(postId, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`${POST_FULL}?post_id=${postId}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (Number(data.retcode) === 1034) {
        throttledUntil = Date.now() + 10 * 60 * 1000
        return null
      }
      if (Number(data.retcode) !== 0) return null
      return data.data?.post?.post || null
    } catch (error) {
      if (attempt === retries) return null
      await sleep(400)
    }
  }
  return null
}

/** 按并发上限依次执行，保留输入顺序 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
      await sleep(DETAIL_GAP_MS)
    }
  })
  await Promise.all(runners)
  return results
}

/** 从版本维护公告里拿到「9.1 版本维护结束时间」，用于补全「9.1版本更新后」这类起点 */
async function buildVersionAnchors(posts, existing = {}) {
  const anchors = {}
  for (const [version, value] of Object.entries(existing)) {
    const date = value instanceof Date ? value : new Date(Number(value))
    if (!Number.isNaN(date.getTime())) anchors[version] = date
  }
  const candidates = posts.filter(post => VERSION_NOTICE_RE.test(post.subject || ''))
  const details = await mapLimit(candidates, 2, post => fetchDetail(post.post_id, 0))
  candidates.forEach((post, index) => {
    const detail = details[index]
    const version = String(post.subject || '').match(/(\d+\.\d+)/)?.[1]
    if (!detail || !version) return
    const text = plainText(detail.content)
    const match = text.match(/维护时间[^\d]{0,8}(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[~～\-—至]\s*(\d{1,2})\s*[:：]\s*(\d{2})/)
    if (!match) return
    const created = new Date(Number(detail.created_at || post.created_at || 0) * 1000)
    const year = Number.isNaN(created.getTime()) ? new Date().getFullYear() : created.getFullYear()
    const month = Number(match[1])
    const anchorYear = month < created.getMonth() + 1 - 6 ? year + 1 : year
    // 用维护结束时间作为「版本更新后」的起点
    anchors[version] = new Date(anchorYear, month - 1, Number(match[2]), Number(match[5]), Number(match[6]))
  })
  return anchors
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, CACHE_FILE)
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/**
 * 抓取公告并整理成卡池 / 活动
 * @returns {Promise<{pools: Array<object>, events: Array<object>, source: string}>}
 *   item: { name, type, start: Date, end: Date, postId, subject }
 */
export async function fetchAnnouncements(now = new Date()) {
  if (memoryCache && now.getTime() - memoryCache.at < CACHE_TTL_MS) return memoryCache.data
  // 同一时间只允许一次抓取，避免多人同时发命令时重复打接口
  if (inflight) return inflight
  inflight = fetchAnnouncementsInner(now).finally(() => {
    inflight = null
  })
  return inflight
}

async function fetchAnnouncementsInner(now = new Date()) {
  const cached = readCache()
  const cache = cached && cached.v === CACHE_VERSION ? cached : {}
  const postCache = cache.posts && typeof cache.posts === 'object' ? cache.posts : {}

  // type=1 是官方「公告」（补给 / 活动 / 试炼都在这里），type=2 是社区有奖活动，噪音较大
  const posts = (await fetchNews(1))
    .filter(post => !SKIP_RE.test(post.subject || ''))
    .filter(post => {
      const created = Number(post.created_at || post.created || 0) * 1000
      return !created || now.getTime() - created < MAX_POST_AGE_DAYS * 86400000
    })
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))

  // 详情接口连发十几次就会开始拒绝，每次只补一批还没解析过的公告；
  // 解析结果按 post_id 缓存，几轮之后整页公告就都覆盖到了。
  const pending = posts.filter(post => !postCache[post.post_id])
  const isVersionNotice = post => VERSION_NOTICE_RE.test(post.subject || '')
  const batch = [
    ...pending.filter(isVersionNotice),
    ...pending.filter(post => !isVersionNotice(post)),
  ].slice(0, DETAIL_BATCH)

  // 先解析版本维护时间，正文里的「9.1版本更新后」才补得出起点
  const anchors = await buildVersionAnchors(batch, cache.anchors || {})
  const details = Date.now() < throttledUntil
    ? batch.map(() => null)
    : await mapLimit(batch, DETAIL_CONCURRENCY, post => fetchDetail(post.post_id))

  batch.forEach((post, index) => {
    const detail = details[index]
    if (!detail) return
    // 版本更新公告本身不是活动，只用来推断「版本更新后」的时间锚点
    if (VERSION_NOTICE_RE.test(post.subject || '')) {
      postCache[post.post_id] = { at: Date.now(), item: null }
      return
    }
    const text = plainText(detail.content)
    const created = new Date(Number(detail.created_at || post.created_at || 0) * 1000)
    const ranges = parseTimeRanges(text, Number.isNaN(created.getTime()) ? now : created, anchors)
    if (!ranges.length) {
      postCache[post.post_id] = { at: Date.now(), item: null }
      return
    }
    const range = ranges[0]
    const info = classify(detail)
    postCache[post.post_id] = {
      at: Date.now(),
      item: {
        name: info.name,
        type: info.type,
        isPool: info.isPool,
        start: range.start.getTime(),
        end: range.end.getTime(),
        postId: String(post.post_id),
        subject: info.subject,
      },
    }
  })

  const pools = []
  const events = []
  const alive = new Set(posts.map(post => String(post.post_id)))
  for (const id of Object.keys(postCache)) {
    if (!alive.has(id)) delete postCache[id]
  }
  for (const post of posts) {
    const entry = postCache[post.post_id]
    if (!entry?.item) continue
    // 兜底：旧缓存里可能把版本更新公告当成了活动
    if (VERSION_NOTICE_RE.test(entry.item.subject || '')) continue
    const item = {
      name: entry.item.name,
      type: entry.item.type,
      start: new Date(entry.item.start),
      end: new Date(entry.item.end),
      postId: entry.item.postId,
      subject: entry.item.subject,
    }
    if (entry.item.isPool) pools.push(item)
    else events.push(item)
  }

  const anchorStore = {}
  for (const [version, date] of Object.entries(anchors)) anchorStore[version] = date.getTime()

  const data = { v: CACHE_VERSION, pools, events, fetchedAt: new Date().toISOString(), posts: postCache, anchors: anchorStore }
  if (pools.length || events.length) {
    memoryCache = { at: now.getTime(), data }
    writeCache(data)
    return data
  }

  // 一条都没解析出来通常是被限流了，这时退回上一次的缓存，别让日历整页空白
  const fallback = readAnnouncementCache()
  if (fallback) {
    memoryCache = { at: now.getTime(), data: fallback }
    return fallback
  }
  memoryCache = { at: now.getTime(), data }
  return data
}

/** 读取缓存（供抓取失败时兜底） */
export function readAnnouncementCache() {
  const cache = readCache()
  if (!cache || !Array.isArray(cache.pools)) return null
  const revive = item => ({ ...item, start: new Date(item.start), end: new Date(item.end) })
  return {
    pools: cache.pools.map(revive),
    events: (cache.events || []).map(revive),
    fetchedAt: cache.fetchedAt || '',
  }
}
