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
const MAX_POST_AGE_DAYS = 45
const MAX_DETAIL_POSTS = 10

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 miHoYoBBS/2.102.1',
  Referer: 'https://www.miyoushe.com/',
  'X-Requested-With': 'XMLHttpRequest',
}

let memoryCache = null
let inflight = null

const POOL_RE = /^【补给】|装备补给|跃升武装|跃升补给|精准补给|扩充补给|家园补给|服装补给/
const EVENT_RE = /活动|试炼|协战|登录|签到|开放|远征|玩法/
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
 * @param {string} text 纯文本正文
 * @param {Date} created 公告发布时间，用于补年份
 */
export function parseTimeRanges(text, created = new Date()) {
  const body = String(text || '')
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
      : /服装/.test(subject)
        ? '服装'
        : /家园/.test(subject)
          ? '家园'
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
  const data = await fetchJson(`${NEWS_LIST}?gids=1&type=${type}&page_size=20`)
  if (Number(data.retcode) !== 0) throw new Error(data.message || '公告列表接口异常')
  return (data.data?.list || []).map(item => item.post).filter(Boolean)
}

async function fetchDetail(postId) {
  const data = await fetchJson(`${POST_FULL}?post_id=${postId}`)
  if (Number(data.retcode) !== 0) return null
  return data.data?.post?.post || null
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
  // type=1 是官方「公告」（补给 / 活动 / 试炼都在这里），type=2 是社区有奖活动，噪音较大
  const posts = (await fetchNews(1))
    .filter(post => !SKIP_RE.test(post.subject || ''))
    .filter(post => {
      const created = Number(post.created_at || post.created || 0) * 1000
      return !created || now.getTime() - created < MAX_POST_AGE_DAYS * 86400000
    })
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))

  const pools = []
  const events = []
  const seen = new Set()
  let detailCount = 0

  for (const post of posts) {
    if (detailCount >= MAX_DETAIL_POSTS) break
    if (seen.has(post.post_id)) continue
    seen.add(post.post_id)
    if (!POOL_RE.test(post.subject || '') && !EVENT_RE.test(post.subject || '')) continue

    let detail = null
    try {
      detail = await fetchDetail(post.post_id)
      detailCount += 1
    } catch {
      continue
    }
    if (!detail) continue

    const text = plainText(detail.content)
    const ranges = parseTimeRanges(text, new Date(Number(detail.created_at || 0) * 1000))
    if (!ranges.length) continue

    // 优先取正文里第一个时间段；同一篇公告里后面的多为礼包/商城时间
    const range = ranges[0]
    const info = classify(detail)
    const item = {
      name: info.name,
      type: info.type,
      start: range.start,
      end: range.end,
      postId: String(post.post_id),
      subject: info.subject,
    }
    if (info.isPool) pools.push(item)
    else events.push(item)
  }

  const data = { pools, events, fetchedAt: new Date().toISOString() }
  memoryCache = { at: now.getTime(), data }
  if (pools.length || events.length) writeCache(data)
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
