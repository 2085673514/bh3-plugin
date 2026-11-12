import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './jsonFile.js'
import { loadEventData } from './calendarData.js'
import { buildWeeklyPeriods } from './calendar.js'
import { buildCalendarCard } from './mys/card.js'
import { renderMysTemplate } from './mys/render.js'

const SUB_FILE = path.join(process.cwd(), 'data', 'bh3', 'calendar-sub.json')
// 到点后多久之内还算「今天该发」（机器人重启 / 短暂离线时不至于漏掉）
const DAILY_WINDOW_MS = 6 * 60 * 60 * 1000
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
  calendarLogger?.info?.(`[bh3] 日历订阅已保存：${key} 每天 ${at}${exist ? '' : '（新增）'}`)
  return { time: at, created: !exist }
}

/** 取消订阅 */
export function removeCalendarSub(target) {
  const store = readStore()
  const key = targetKey(target)
  const before = store.subs.length
  store.subs = store.subs.filter(sub => targetKey(sub) !== key)
  if (store.state.daily) delete store.state.daily[key]
  writeStore(store)
  calendarLogger?.info?.(`[bh3] 日历订阅已取消：${key}`)
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
    '当天有卡池 / 活动开启或结束、以及深渊结算日，会补一条文字提醒',
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
    // 按「日期 + 推送时间」去重：当天改过推送时间后，新的时间点会再推一次
    if (store.state.daily[targetKey(sub)] === dailyMark(sub, today)) continue
    due.push(sub)
  }
  if (!due.length) return

  const { data, img } = await renderCalendarImage(now)
  const segment = globalThis.segment
  const notice = buildTodayNotice(data, now)
  for (const sub of due) {
    const target = { type: sub.type, id: sub.id }
    try {
      if (img && segment?.image) {
        await sendTo(target, [segment.image(img)])
      } else {
        await sendTo(target, buildCalendarText(data, now))
      }
      // 日历图之后再补一条「今日开启 / 结束 / 深渊结算」的文字提醒
      if (notice) {
        try {
          await sendTo(target, notice)
        } catch (error) {
          logger?.warn?.(`[bh3] 今日提醒发送失败（${targetKey(sub)}）：${error.message}`)
        }
      }
      store.state.daily[targetKey(sub)] = dailyMark(sub, today)
      writeStore(store)
      logger?.info?.(`[bh3] 活动日历已推送到 ${targetKey(sub)}（每天 ${sub.time}）`)
    } catch (error) {
      logger?.warn?.(`[bh3] 日历订阅推送失败（${targetKey(sub)}）：${error.message}`)
    }
  }
}

/** 当日提醒文字：今天开启 / 今天结束的卡池与活动，以及深渊结算日提示；没有可提醒的内容返回空串 */
export function buildTodayNotice(data, now = new Date()) {
  if (!data) return ''
  const today = dateKey(now)
  const items = [...(data.pools || []), ...(data.events || [])].filter(
    (item) => item && Number.isFinite(item.startMs) && Number.isFinite(item.endMs),
  )
  const started = items.filter((item) => dateKey(new Date(item.startMs)) === today)
  const ending = items.filter((item) => dateKey(new Date(item.endMs)) === today && item.endMs > now.getTime())
  const abyss = (data.weeklyPeriods || []).find((item) => {
    if (!item?.at || item.key !== 'abyss') return false
    const at = item.at instanceof Date ? item.at : new Date(item.at)
    return at.getTime() > now.getTime() && sameDay(at, now)
  })
  if (!started.length && !ending.length && !abyss) return ''

  const lines = ['【崩坏3 今日提醒】']
  if (started.length) {
    lines.push(`今日开启：${started.map((item) => `${item.name}（${fmtClock(item.startMs).slice(6)} 起）`).join('、')}`)
  }
  if (ending.length) {
    lines.push(
      `今日结束：${ending
        .map((item) => `${item.name}（${fmtClock(item.endMs).slice(6)} 结束，还剩 ${remainText(item.endMs - now.getTime())}）`)
        .join('、')}`,
    )
  }
  if (abyss) {
    lines.push(`今晚 ${abyss.timeText} 深渊结算（超弦空间 · 还剩 ${remainText(abyss.at.getTime() - now.getTime())}）`)
  }
  return lines.join('\n')
}

export async function checkCalendarSubs(logger, now = new Date()) {
  try {
    await checkDailyCalendar(logger, now)
  } catch (error) {
    logger?.warn?.(`[bh3] 日历订阅推送检查失败：${error.message}`)
  }
}

let calendarTimer = null
let calendarLogger = null

function dateKey(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 两个时间是否同一天（本地时区） */
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 每日推送的去重标记：日期 + 推送时间，改时间后当天可以再推一次 */
function dailyMark(sub, today) {
  return `${today} ${sub?.time || DEFAULT_TIME}`
}

/** 下一次推送时间（今天没到就算今天，否则明天） */
function nextDailyAt(time = DEFAULT_TIME, now = new Date()) {
  const [hour, minute] = String(time).split(':').map(Number)
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour || 0, minute || 0, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime()
}

/**
 * 下一个需要唤醒的时刻：各订阅的每日推送时间。
 * 有订阅时至少有每日推送这个事件，所以不必再加轮询兜底。
 */
export function nextCalendarWake(now = new Date(), store = readStore()) {
  if (!store.subs.length) return 0
  const at = now.getTime()
  let next = 0
  const take = value => {
    if (value > at && (!next || value < next)) next = value
  }

  for (const sub of store.subs) {
    if (sub.enabled === false) continue
    take(nextDailyAt(sub.time, now))
  }

  return next
}

function armCalendarTimer(logger = calendarLogger) {
  calendarLogger = logger || calendarLogger
  if (calendarTimer) {
    clearTimeout(calendarTimer)
    calendarTimer = null
  }
  const store = readStore()
  if (!store.subs.length) return
  const next = nextCalendarWake(new Date(), store)
  if (!next) return
  const delay = Math.max(1000, next - Date.now())
  logger?.info?.(
    `[bh3] 下一次活动日历唤醒：${new Date(next).toLocaleString('zh-CN', { hour12: false })}（${Math.round(delay / 60000)} 分钟后）`,
  )
  calendarTimer = setTimeout(async () => {
    calendarTimer = null
    try {
      await checkCalendarSubs(calendarLogger)
    } catch (error) {
      calendarLogger?.warn?.(`[bh3] 日历订阅推送检查失败：${error.message}`)
    } finally {
      armCalendarTimer()
    }
  }, delay)
  calendarTimer.unref?.()
}

/** 订阅 / 取消订阅后：先补一次（时间点已过也能立刻推），再按新时间重排定时器 */
export function rescheduleCalendarSubs(logger = calendarLogger) {
  if (!globalThis.__bh3CalendarSubScheduler) return
  calendarLogger = logger || calendarLogger
  checkCalendarSubs(calendarLogger)
    .catch(error => calendarLogger?.warn?.(`[bh3] 日历订阅推送检查失败：${error.message}`))
    .finally(() => armCalendarTimer(calendarLogger))
}

/** 启动日历订阅调度（进程内只启动一次）：启动时补一次，然后只在下一个事件到来时唤醒 */
export function scheduleCalendarSubs(logger = globalThis.logger) {
  if (globalThis.__bh3CalendarSubScheduler) return
  globalThis.__bh3CalendarSubScheduler = true
  calendarLogger = logger
  const store = readStore()
  if (!store.subs.length) {
    logger?.info?.('[bh3] 活动日历订阅已加载（暂无订阅）')
    return
  }
  // 启动补发：离线期间错过的推送在这里补上，然后按下一个事件重排
  checkCalendarSubs(logger)
    .catch(error => logger?.warn?.(`[bh3] 日历订阅推送检查失败：${error.message}`))
    .finally(() => armCalendarTimer(logger))
  logger?.info?.(`[bh3] 活动日历订阅已加载（${store.subs.length} 个目标，按事件定时唤醒）`)
}
