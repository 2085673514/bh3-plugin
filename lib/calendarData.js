/**
 * 活动日历数据源：卡池 / 活动的起止时间。
 *
 * 说明：米游社没有公开的崩坏3公告接口（announcement-api、api-takumi、bbs-api、
 * hk4e/hkrpg 风格域名、blackboard 各 app_sn 均实测不可用），所以这部分数据
 * 采用「本地 JSON + 可选远程 JSON」的方式维护：
 *   1. data/bh3/calendar.json      —— 本地文件，手动或外部脚本写入
 *   2. BH3_CALENDAR_URL            —— 远程 JSON（同结构），有则优先，缓存 10 分钟
 * 周常节点（深渊开放/结算、战场乐土重置）由 lib/calendar.js 本地推算，不依赖网络。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fetchWithRetry } from './http.js'
import { fmtCountdown } from './calendar.js'

const DATA_FILE = path.join(process.cwd(), 'data', 'bh3', 'calendar.json')
const CACHE_TTL_MS = 10 * 60 * 1000

let remoteCache = null

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function readRemote() {
  const url = String(process.env.BH3_CALENDAR_URL || '').trim()
  if (!url) return null
  if (remoteCache && Date.now() - remoteCache.at < CACHE_TTL_MS) return remoteCache.data
  try {
    const res = await fetchWithRetry(url, {}, { timeoutMs: 10000, retries: 0 })
    const data = await res.json()
    remoteCache = { at: Date.now(), data }
    return data
  } catch (error) {
    globalThis.logger?.warn?.(`[bh3] 远程日历数据拉取失败：${error.message}`)
    return null
  }
}

/** "2026-11-06 12:00" / "2026-11-06T12:00:00" / 秒级时间戳 -> Date */
function parseTime(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000)
  const text = String(value).trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return new Date(n > 1e12 ? n : n * 1000)
  }
  const date = new Date(text.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatTime(date) {
  if (!date) return ''
  const pad = v => String(v).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 归一化一条记录，并算出状态 / 倒计时 / 进度
 * @param {object} item 原始记录 { name, type, start, end, note, tag }
 * @param {Date} now
 */
function normalizeItem(item, now) {
  if (!item || !item.name) return null
  const start = parseTime(item.start)
  const end = parseTime(item.end)
  if (!start || !end) return null
  const nowMs = now.getTime()
  const startMs = start.getTime()
  const endMs = end.getTime()
  if (endMs <= startMs) return null

  let status = 'ongoing'
  let statusText = '进行中'
  let countdown = ''
  if (nowMs < startMs) {
    status = 'upcoming'
    statusText = '即将开始'
    countdown = `${fmtCountdown(startMs - nowMs)}后开始`
  } else if (nowMs > endMs) {
    status = 'ended'
    statusText = '已结束'
    countdown = `已结束 ${fmtCountdown(nowMs - endMs)}`
  } else {
    countdown = `剩余 ${fmtCountdown(endMs - nowMs)}`
  }

  const total = endMs - startMs
  const progress = Math.max(0, Math.min(100, Math.round(((nowMs - startMs) / total) * 100)))

  return {
    name: String(item.name),
    type: String(item.type || item.tag || ''),
    note: String(item.note || ''),
    startText: formatTime(start),
    endText: formatTime(end),
    startMs,
    endMs,
    status,
    statusText,
    countdown,
    // 即将开始按 0% 显示，已结束按 100%
    progress: status === 'upcoming' ? 0 : status === 'ended' ? 100 : progress,
    isOngoing: status === 'ongoing',
  }
}

/**
 * 读取并整理卡池 / 活动数据
 * @param {Date} [now]
 * @returns {{ pools: Array<object>, events: Array<object>, source: string, configured: boolean }}
 */
export async function loadEventData(now = new Date()) {
  const remote = await readRemote()
  const local = readLocal()
  const data = remote || local
  const source = remote ? '远程' : local ? '本地' : 'none'
  if (!data || typeof data !== 'object') {
    return { pools: [], events: [], source, configured: false }
  }

  const pick = list => (Array.isArray(list) ? list : [])
    .map(item => normalizeItem(item, now))
    .filter(Boolean)
    // 已结束超过 3 天的不再展示
    .filter(item => item.status !== 'ended' || now.getTime() - item.endMs < 3 * 24 * 60 * 60 * 1000)
    .sort((a, b) => {
      if (a.status !== b.status) {
        const order = { ongoing: 0, upcoming: 1, ended: 2 }
        return order[a.status] - order[b.status]
      }
      return a.endMs - b.endMs
    })

  return {
    pools: pick(data.pools),
    events: pick(data.events),
    source,
    configured: true,
  }
}
