import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './jsonFile.js'
import { loadEventData } from './calendarData.js'
import { buildWeeklyPeriods } from './calendar.js'
import { buildCalendarCard } from './mys/card.js'
import { renderMysTemplate } from './mys/render.js'

const SUB_FILE = path.join(process.cwd(), 'data', 'bh3', 'calendar-sub.json')
const CHECK_INTERVAL_MS = 60 * 1000
// 到点后多久之内还算「今天该发」（机器人重启 / 短暂离线时不至于漏掉）
const DAILY_WINDOW_MS = 6 * 60 * 60 * 1000
const ENDING_HOURS = Math.max(1, Number(process.env.BH3_CAL_ENDING_HOURS) || 24)
const DEFAULT_TIME = '08:00'

const pad = value => String(value).padStart(2, '0')

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(SUB_FILE, 'utf8'))
    return {
      subs: Array.isArray(data.subs) ? data.subs : [],
      state: data.state && typeof data.state === 'object' ? data.state : {},
    }
  } catch {
    return { subs: [], state: {} }
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(path.dirname(SUB_FILE), { recursive: true })
    writeJsonAtomic(SUB_FILE, store, { pretty: true })
  } catch {
    /* 订阅文件写失败不影响主流程 */
  }
}

export function normalizeCalendarTime(text = '') {
  const match = String(text).trim().match(/^(\d{1,2})[:：](\d{2})$/)
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return ''
  return `${pad(hour)}:${pad(minute)}`
}

function targetKey(target) {
  return `${target.type}:${target.id}`
}

/** 订阅：同一目标只保留一条，重复订阅视为改时间 */
export function saveCalendarSub(target, { time = DEFAULT_TIME, by = '' } = {}, now = new Date()) {
  const store = readStore()
  const key = targetKey(target)
  const at = normalizeCalendarTime(time) || DEFAULT_TIME
  const exist = store.subs.find(sub => targetKey(sub) === key)
  if (exist) {
    exist.time = at
    exist.enabled = true
    exist.by = by || exist.by
  } else {
    store.subs.push({
      type: target.type,
      id: String(target.id),
      time: at,
      enabled: true,
      by: String(by || ''),
      createdAt: now.toISOString(),
    })
  }
  writeStore(store)
  return { time: at, created: !exist }
}

/** 取消订阅 */
export function removeCalendarSub(target) {
  const store = readStore()
  const key = targetKey(target)
  const before = store.subs.length
  store.subs = store.subs.filter(sub => targetKey(sub) !== key)
  if (store.state.daily) delete store.state.daily[key]
  if (store.state.ending) delete store.state.ending[key]
  writeStore(store)
  return store.subs.length !== before
}

export function getCalendarSub(target) {
  const store = readStore()
  const key = targetKey(target)
  return store.subs.find(sub => targetKey(sub) === key) || null
}

export function calendarSubStatus(target) {
  const sub = getCalendarSub(target)
  if (!sub) return `本${target.type === 'group' ? '群' : '会话'}还没有订阅活动日历。\n发 #崩坏3订阅日历 即可订阅（默认每天 ${DEFAULT_TIME} 推送），也可以 #崩坏3订阅日历 20:30 指定时间。`
  return [
    `活动日历订阅：已开启（每天 ${sub.time} 推送当日日历）`,
    `活动结束提醒：结束前 ${ENDING_HOURS} 小时内单独提醒`,
    '',
    '用法：#崩坏3订阅日历 [HH:mm] / 关闭',
  ].join('\n')
}

async function sendTo(target, message) {
  const bot = globalThis.Bot
  if (!bot) throw new Error('Bot 尚未就绪')
  if (target.type === 'group') {
    await bot.sendGroupMsg(bot.uin?.[0], target.id, message)
  } else {
    await bot.sendFriendMsg(bot.uin?.[0], target.id, message)
  }
}

function fmtClock(value) {
  const date = value instanceof Date ? value : new Date(value)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function remainText(ms) {
  const minute = Math.max(0, Math.round(ms / 60000))
  const day = Math.floor(minute / 1440)
  const hour = Math.floor((minute % 1440) / 60)
  if (day) return `${day} 天 ${hour} 小时`
  if (hour) return `${hour} 小时 ${minute % 60} 分钟`
  return `${minute} 分钟`
}

/** 文字版日历（出图失败时的兜底，也用于日志摘要） */
export function buildCalendarText(data, now = new Date()) {
  const lines = [`【崩坏3 活动日历】${pad(now.getMonth() + 1)}-${pad(now.getDate())}`]
  const ongoing = [...data.pools, ...data.events]
    .filter(item => item.endMs > now)
    .sort((a, b) => a.endMs - b.endMs)
  const poolCount = data.pools.filter(item => item.endMs > now).length
  const eventCount = data.events.filter(item => item.endMs > now).length
  lines.push(`进行中：卡池 ${poolCount} · 活动 ${eventCount}`)
  for (const item of ongoing.slice(0, 6)) {
    lines.push(`· ${item.name}　${fmtClock(item.endMs)} 结束（剩 ${remainText(item.endMs - now)}）`)
  }
  if (ongoing.length > 6) lines.push(`· …另外 ${ongoing.length - 6} 项进行中`)
  if (data.weeklyPeriods?.length) {
    const weekly = data.weeklyPeriods[0]
    lines.push(`周常最近一期：${weekly.name} ${weekly.dateText} ${weekly.timeText}`)
  }
  return lines.join('\n')
}

/** 取当日日历数据（卡池 / 活动 / 周常） */
export async function collectCalendar(now = new Date()) {
  const raw = await loadEventData(now)
  return buildCalendarCard({ ...raw, weeklyPeriods: buildWeeklyPeriods(now, { settleTime: '22:00' }) })
}

/** 生成当日日历图，失败返回 null */
async function renderCalendarImage(now = new Date()) {
  const data = await collectCalendar(now)
  if (!data.rows.length && !data.weeklyPeriods.length) return { data, img: null }
  try {
    const img = await renderMysTemplate('bh3calendar', data, { deviceScaleFactor: 2, quality: 90, waitImages: 8000 })
    return { data, img }
  } catch {
    return { data, img: null }
  }
}

/** 每天到点推送当日日历 */
export async function checkDailyCalendar(logger, now = new Date()) {
  const store = readStore()
  if (!store.subs.length) return
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const due = []
  for (const sub of store.subs) {
    if (!sub.enabled) continue
    const [hour, minute] = String(sub.time || DEFAULT_TIME).split(':').map(Number)
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour || 0, minute || 0)
    if (now < at || now - at > DAILY_WINDOW_MS) continue
    store.state.daily = store.state.daily || {}
    if (store.state.daily[targetKey(sub)] === today) continue
    due.push(sub)
  }
  if (!due.length) return

  const { data, img } = await renderCalendarImage(now)
  const segment = globalThis.segment
  for (const sub of due) {
    const target = { type: sub.type, id: sub.id }
    try {
      if (img && segment?.image) {
        await sendTo(target, [segment.image(img)])
      } else {
        await sendTo(target, buildCalendarText(data, now))
      }
      store.state.daily[targetKey(sub)] = today
      writeStore(store)
    } catch (error) {
      logger?.warn?.(`[bh3] 日历订阅推送失败（${targetKey(sub)}）：${error.message}`)
    }
  }
}

/** 活动 / 卡池快结束时单独提醒 */
export async function checkEndingCalendar(logger, now = new Date()) {
  const store = readStore()
  if (!store.subs.length) return
  const data = await collectCalendar(now).catch(() => null)
  if (!data) return
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const ending = [...data.pools, ...data.events]
    .filter(item => item.endMs > now && item.endMs - now <= ENDING_HOURS * 3600 * 1000)
    .sort((a, b) => a.endMs - b.endMs)
  if (!ending.length) return

  for (const sub of store.subs) {
    if (!sub.enabled) continue
    const key = targetKey(sub)
    store.state.ending = store.state.ending || {}
    const notified = store.state.ending[key] || {}
    const fresh = ending.filter(item => notified[item.postId] !== today)
    if (!fresh.length) continue
    const lines = ['【崩坏3 活动提醒】即将结束']
    for (const item of fresh.slice(0, 8)) {
      lines.push(`· ${item.name}　${fmtClock(item.endMs)}（剩 ${remainText(item.endMs - now)}）`)
    }
    if (fresh.length > 8) lines.push(`· …另外 ${fresh.length - 8} 项`)
    try {
      await sendTo({ type: sub.type, id: sub.id }, lines.join('\n'))
      for (const item of fresh) notified[item.postId] = today
      store.state.ending[key] = notified
      writeStore(store)
    } catch (error) {
      logger?.warn?.(`[bh3] 活动结束提醒失败（${key}）：${error.message}`)
    }
  }
}

export async function checkCalendarSubs(logger, now = new Date()) {
  try {
    await checkEndingCalendar(logger, now)
  } catch (error) {
    logger?.warn?.(`[bh3] 活动结束提醒检查失败：${error.message}`)
  }
  try {
    await checkDailyCalendar(logger, now)
  } catch (error) {
    logger?.warn?.(`[bh3] 日历订阅推送检查失败：${error.message}`)
  }
}

/** 启动日历订阅检查（进程内只启动一次） */
export function scheduleCalendarSubs(logger = globalThis.logger) {
  if (globalThis.__bh3CalendarSubScheduler) return
  globalThis.__bh3CalendarSubScheduler = true
  const timer = setInterval(() => {
    checkCalendarSubs(logger).catch(error => logger?.warn?.(`[bh3] 日历订阅检查失败：${error.message}`))
  }, CHECK_INTERVAL_MS)
  timer.unref?.()
  const store = readStore()
  logger?.info?.(`[bh3] 活动日历订阅已加载（${store.subs.length} 个目标）`)
}
