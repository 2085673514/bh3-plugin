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

// 同一套接口在多个域名下都有部署，限流是分开算的：
// api-takumi 抓多了会返回 retcode 1034，而 bbs-api 此时通常还能用。
const API_HOSTS = [
  'https://bbs-api.miyoushe.com',
  'https://bbs-api.mihoyo.com',
  'https://api-takumi.mihoyo.com',
]
const NEWS_PATH = '/post/wapi/getNewsList'
const POST_PATH = '/post/wapi/getPostFull'
const CACHE_FILE = path.join(process.cwd(), 'data', 'bh3', 'calendar-cache.json')
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_POST_AGE_DAYS = 75
const CACHE_VERSION = 5
const NEWS_PAGE_SIZE = 30
const NEWS_MAX_PAGES = 3
const DETAIL_BATCH = 12
// 75 天内的公告有 40+ 篇，多补几轮，一次调用就能把整页解析完
const DETAIL_ROUNDS = 6
const DETAIL_CONCURRENCY = 2
const DETAIL_GAP_MS = 650

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 miHoYoBBS/2.102.1',
  Referer: 'https://www.miyoushe.com/',
  'X-Requested-With': 'XMLHttpRequest',
}

let memoryCache = null
let inflight = null
// 被公告接口限流（retcode 1034）后，冷却期内不再抓详情，避免越抓越久
let throttledUntil = 0

// 「装备补给卡 / 角色补给卡」是奖励道具，不能据此判成卡池公告
const POOL_RE = /^【补给】|(?:装备补给|角色补给|跃升武装|跃升补给|精准补给|扩充补给|家园补给|服装补给|协同者补给)(?!卡)/
const VERSION_NOTICE_RE = /(\d+\.\d+)\s*版本(?:维护通知|更新公告)/
// 只过滤真正的噪音；「充值返利 / 签到有奖」这类本身是活动，不能再误杀
const SKIP_RE = /封禁|处罚|问卷|修复|说明|防沉迷|举报|客服|下载|周边|生日|已开奖|讨论|盖楼|抽奖|征集|开奖/

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
  //    也支持带年份的写法（跨年活动很常见）：
  //    11月26日11:00~2027年1月8日12:00 / 2026年11月6日~11月26日
  const cnRe = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}[:：]\d{2})?\s*(?:[~～\-—–−－]|至|到)\s*(?:(\d{4})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日\s*(\d{1,2}[:：]\d{2})?/g
  for (const m of body.matchAll(cnRe)) {
    const startMonth = Number(m[2])
    const startDay = Number(m[3])
    const endMonth = Number(m[6] || m[2])
    const endDay = Number(m[7])
    const startClock = parseClock(m[4])
    const endClock = parseClock(m[8])
    const startYear = m[1] ? Number(m[1]) : inferYear(startMonth)
    const endYear = m[5] ? Number(m[5]) : endMonth < startMonth - 6 ? startYear + 1 : startYear
    const start = new Date(startYear, startMonth - 1, startDay, startClock?.hour ?? 12, startClock?.minute ?? 0)
    const end = new Date(endYear, endMonth - 1, endDay, endClock?.hour ?? 4, endClock?.minute ?? 0)
    if (end > start) results.push({ start, end })
  }

  return results
}

/** 公告标题 -> 去掉前缀、统一分隔符后的展示名 */
export function normalizeName(subject = '') {
  return String(subject)
    .replace(/^【[^】]*】\s*/, '')
    .replace(/[丨|｜]/g, ' · ')
    .replace(/\s*·\s*/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 公告标题 -> 展示名与分类 */
export function classify(post) {
  const subject = String(post.subject || '')
  const name = normalizeName(subject)
  const isPool = POOL_RE.test(subject)
  // 卡池按装备 / 角色 / 服装等分色；非卡池再按活动性质分，避免「装备补给卡」之类把活动算成卡池
  const type = isPool
    ? /装备补给|跃升武装/.test(subject)
      ? '装备'
      : /角色补给|跃升补给/.test(subject)
        ? '角色'
        : /家园/.test(subject)
          ? '家园'
          : /服装补给/.test(subject)
            ? '服装'
            : /协同者补给/.test(subject)
              ? '协同'
              : '补给'
    : /登录|签到/.test(subject)
      ? '福利'
      : /累消|累充|祈礼/.test(subject)
        ? '累消'
        : /作战凭证/.test(subject)
          ? '凭证'
          : '活动'
  return { name, isPool, type, subject }
}

async function fetchJson(url) {
  const res = await fetchWithRetry(url, { headers: HEADERS }, { timeoutMs: 15000, retries: 1 })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 按域名顺序请求同一个接口：某个域名被限流（1034）或报错就换下一个。
 * @param {string} path 接口路径
 * @param {string} query 查询串
 * @param {string} [preferredHost] 优先使用的域名（翻页时保持同一个）
 * @returns {Promise<any|null>} 返回原始 json，附带 __host 标记来源域名
 */
async function fetchAny(path, query, preferredHost = '') {
  const hosts = preferredHost ? [preferredHost, ...API_HOSTS.filter(host => host !== preferredHost)] : API_HOSTS
  let allThrottled = true
  for (const host of hosts) {
    try {
      const data = await fetchJson(`${host}${path}?${query}`)
      const retcode = Number(data?.retcode)
      if (retcode === 0) return Object.assign(data, { __host: host })
      if (retcode !== 1034) allThrottled = false
    } catch {
      allThrottled = false
    }
  }
  // 所有域名都被限流才进入冷却，避免一个域名抽风就停摆
  if (allThrottled) throttledUntil = Date.now() + 10 * 60 * 1000
  return null
}

/**
 * 拉公告列表。
 * 接口一页最多 30 条且 is_last 常常是 false（75 天内通常有 40+ 篇），
 * 只取第一页会漏掉较早的活动，所以按 last_id 翻页，直到取完或达到上限。
 */
async function fetchNews(type) {
  const posts = []
  const seen = new Set()
  let lastId = ''
  // 是否把列表取完整了：只有完整时才允许按「当前列表」清理旧缓存，
  // 否则一次翻页失败就会把已解析的公告误删，导致活动时多时少
  let complete = false
  // 固定用一个能用的域名翻页，避免不同域名的 last_id 语义不一致
  let host = ''
  for (let page = 0; page < NEWS_MAX_PAGES; page += 1) {
    const query = `gids=1&type=${type}&page_size=${NEWS_PAGE_SIZE}${lastId ? `&last_id=${lastId}` : ''}`
    const data = await fetchAny(NEWS_PATH, query, host)
    if (!data || Number(data.retcode) !== 0) {
      if (posts.length) break
      throw new Error(data?.message || '公告列表接口异常')
    }
    host = data.__host || host
    const list = data.data?.list || []
    for (const item of list) {
      const post = item.post || item
      const id = post?.post_id
      if (!id || seen.has(String(id))) continue
      seen.add(String(id))
      posts.push(post)
    }
    if (data.data?.is_last || !list.length) {
      complete = true
      break
    }
    const next = data.data?.last_id
    if (!next || String(next) === String(lastId)) {
      complete = true
      break
    }
    lastId = next
    await sleep(400)
  }
  // 接口到最后一页也可能一直返回 is_last=false；只要已经翻到超过 75 天的旧公告，
  // 就说明窗口内的公告拿全了
  if (!complete && posts.length) {
    const oldest = Math.min(...posts.map(post => Number(post.created_at || post.created || 0) * 1000).filter(Boolean))
    if (oldest && Date.now() - oldest > MAX_POST_AGE_DAYS * 86400000) complete = true
  }
  return { posts, complete }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 详情接口单独走一个小并发池：公告接口对浏览频率比较宽松，串行抓 30 篇要十几秒。
 * 多域名轮换：api-takumi 被限流时 bbs-api 通常还能取到正文。
 */
async function fetchDetail(postId, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const data = await fetchAny(POST_PATH, `post_id=${postId}`)
    if (data) {
      const post = data.data?.post?.post
      if (post) return post
      return null
    }
    if (attempt === retries) return null
    await sleep(600)
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
 * 没有写时间的补给公告，估算它的结束时间。
 * 优先取「发布时间之后的下一个版本维护时间」——版本卡池通常就开到下一版本维护为止；
 * 这样旧卡池不会因为新版本卡池结束得晚而被拉长到半年后。
 * 没有更晚的版本时，才退回「同类公告里最常见的结束时间」。
 */
function guessEndFor(post, anchors, fallbackEnd) {
  const created = Number(post.created_at || post.created || 0) * 1000
  if (!created) return fallbackEnd
  const later = Object.values(anchors || {})
    .map(value => (value instanceof Date ? value.getTime() : Number(value)))
    .filter(ms => Number.isFinite(ms) && ms > created + 14 * 86400000)
    .sort((a, b) => a - b)
  if (later.length) return later[0]
  return fallbackEnd
}

/** 取同类公告里最常见的结束时间（通常是版本结束的 04:00），用于补齐没有时间的补给公告 */
function guessCommonEnd(postCache, now) {
  const counter = new Map()
  for (const entry of Object.values(postCache)) {
    const item = entry?.item
    if (!item || item.estimated) continue
    if (item.end <= now.getTime()) continue
    counter.set(item.end, (counter.get(item.end) || 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [end, count] of counter) {
    if (count > bestCount || (count === bestCount && end > best)) {
      best = end
      bestCount = count
    }
  }
  return best || 0
}

/** 把一批公告详情解析进缓存：只有能解析出时间段的才留下 */
function applyDetails(batch, details, postCache, anchors, now) {
  batch.forEach((post, index) => {
    const detail = details[index]
    if (!detail) return
    // 版本更新公告本身不是活动，只用来推断「版本更新后」的时间锚点
    if (VERSION_NOTICE_RE.test(post.subject || '')) {
      postCache[post.post_id] = { at: Date.now(), item: null, subject: post.subject || '' }
      return
    }
    const text = plainText(detail.content)
    const created = new Date(Number(detail.created_at || post.created_at || 0) * 1000)
    const ranges = parseTimeRanges(text, Number.isNaN(created.getTime()) ? now : created, anchors)
    if (!ranges.length) {
      postCache[post.post_id] = { at: Date.now(), item: null, subject: post.subject || '' }
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
}

/**
 * 抓取公告并整理成卡池 / 活动
 * @returns {Promise<{pools: Array<object>, events: Array<object>, source: string}>}
 *   item: { name, type, start: Date, end: Date, postId, subject }
 */
const PARTIAL_TTL_MS = 60 * 1000

export async function fetchAnnouncements(now = new Date()) {
  // 上轮只解析了一部分时，1 分钟后就允许重抓，尽快补齐漏掉的活动
  const ttl = memoryCache?.partial ? PARTIAL_TTL_MS : CACHE_TTL_MS
  if (memoryCache && now.getTime() - memoryCache.at < ttl) return memoryCache.data
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
  const news = await fetchNews(1)
  const posts = news.posts
    .filter(post => !SKIP_RE.test(post.subject || ''))
    .filter(post => {
      const created = Number(post.created_at || post.created || 0) * 1000
      return !created || now.getTime() - created < MAX_POST_AGE_DAYS * 86400000
    })
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))

  // 详情接口连发十几次就会开始拒绝，所以分成小批 + 间隔抓；
  // 一次调用尽量多补几轮，把整页公告都覆盖掉，解析结果按 post_id 缓存。
  const isVersionNotice = post => VERSION_NOTICE_RE.test(post.subject || '')
  const anchors = { ...(cache.anchors || {}) }
  for (let round = 0; round < DETAIL_ROUNDS; round += 1) {
    if (Date.now() < throttledUntil) break
    // 只补「完全没抓过」的；已判定为无时间的（estimated）不再重复抓，省接口额度
    const pending = posts.filter(post => !postCache[post.post_id])
    if (!pending.length) break
    const batch = [
      ...pending.filter(isVersionNotice),
      ...pending.filter(post => !isVersionNotice(post)),
    ].slice(0, DETAIL_BATCH)
    // 先解析版本维护时间，正文里的「9.1版本更新后」才补得出起点
    Object.assign(anchors, await buildVersionAnchors(batch, anchors))
    const details = await mapLimit(batch, DETAIL_CONCURRENCY, post => fetchDetail(post.post_id))
    if (!details.some(Boolean)) break
    applyDetails(batch, details, postCache, anchors, now)
  }

  const pools = []
  const events = []
  // 列表没取完整时不要清缓存，否则会把这一轮没拉到的公告连解析结果一起删掉
  if (news.complete) {
    const alive = new Set(posts.map(post => String(post.post_id)))
    for (const id of Object.keys(postCache)) {
      if (!alive.has(id)) delete postCache[id]
    }
  }

  // 部分「补给」公告把补给时间写在配图里，正文只有规则文字。这类公告占位成
  // 「从发布到下一版本维护」，避免整条丢失。
  const inferEnd = guessCommonEnd(postCache, now)
  if (inferEnd) {
    for (const post of posts) {
      const cached = postCache[post.post_id]
      // 已经解析出真实时间的跳过；估算过的每轮按最新版本锚点重算（不花网络请求）
      if (cached?.item && !cached.item.estimated) continue
      if (!POOL_RE.test(post.subject || '')) continue
      const created = new Date(Number(post.created_at || post.created || 0) * 1000)
      if (Number.isNaN(created.getTime())) continue
      const end = guessEndFor(post, anchors, inferEnd)
      const start = new Date(created.getFullYear(), created.getMonth(), created.getDate(), 12, 0)
      if (start.getTime() >= end) continue
      const info = classify(post)
      postCache[post.post_id] = {
        at: Date.now(),
        item: {
          name: info.name,
          type: info.type,
          isPool: info.isPool,
          start: start.getTime(),
          end,
          postId: String(post.post_id),
          subject: info.subject,
          estimated: true,
        },
      }
    }
  }

  // 结果以缓存为准：列表偶尔只拉回一部分（限流 / 翻页失败），
  // 若按「本轮列表」出结果，活动数量就会时多时少
  for (const entry of Object.values(postCache)) {
    if (!entry?.item) continue
    // 兜底：旧缓存里可能把版本更新公告当成了活动
    if (VERSION_NOTICE_RE.test(entry.item.subject || '')) continue
    const item = {
      name: normalizeName(entry.item.name),
      type: entry.item.type,
      start: new Date(entry.item.start),
      end: new Date(entry.item.end),
      postId: entry.item.postId,
      subject: entry.item.subject,
    }
    if (entry.item.isPool) pools.push(item)
    else events.push(item)
  }

  // anchors 可能来自缓存（毫秒数），也可能来自本轮解析（Date），统一存毫秒
  const anchorStore = {}
  for (const [version, value] of Object.entries(anchors)) {
    const ms = value instanceof Date ? value.getTime() : Number(value)
    if (Number.isFinite(ms)) anchorStore[version] = ms
  }

  // 还有公告没解析出来（被限流或超出本轮轮次）就标记为 partial，
  // 上层据此缩短缓存时间，让后续调用尽快补齐，而不是把半成品缓存 15 分钟
  // 只有「压根没抓到」的才算不完整；估算过的已经定稿，不再触发重抓
  const leftover = posts.filter(post => !postCache[post.post_id])
  const partial = leftover.length > 0 || !news.complete || Date.now() < throttledUntil
  const data = {
    v: CACHE_VERSION,
    pools,
    events,
    partial,
    fetchedAt: new Date().toISOString(),
    posts: postCache,
    anchors: anchorStore,
  }
  if (pools.length || events.length) {
    memoryCache = { at: now.getTime(), data, partial }
    writeCache(data)
    return data
  }

  // 一条都没解析出来通常是被限流了：优先返回上一次的好数据，
  // 千万别把空结果写进缓存，否则日历会整页空白，而且再也回不来
  const previous =
    (memoryCache?.data && (memoryCache.data.pools?.length || memoryCache.data.events?.length) ? memoryCache.data : null) ||
    (() => {
      const cached = readAnnouncementCache()
      return cached && (cached.pools.length || cached.events.length) ? cached : null
    })()
  if (previous) {
    memoryCache = { at: now.getTime(), data: previous, partial: true }
    return previous
  }
  memoryCache = { at: now.getTime(), data, partial: true }
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
    // 上一轮没解析完整（限流 / 轮次用完），上层应尽快重新抓取
    partial: cache.partial === true,
  }
}
