/**
 * 崩坏3 固定周期日历。
 *
 * 米游社没有公开的「活动日历」接口（announcement / bbs 系列实测均不可用），
 * 所以这里按游戏内的固定节奏本地推算：日常重置、周常重置、超弦空间开放与结算。
 * 当前正在进行的玩法倒计时另有实时便签（/note）提供，由卡片组装时合并。
 */

/** 游戏内每日 04:00 重置（日常 / 体力任务） */
const DAILY_RESET_HOUR = 4
/** 记忆战场 / 往世乐土：周一 04:00 周重置 */
const WEEKLY_RESET_DAY = 1
/** 超弦空间：周一 / 周四 15:00 开放，周三 / 周日 22:00 结算 */
const ABYSS_OPEN_DAYS = [1, 4]
const ABYSS_OPEN_HOUR = 15
const ABYSS_SETTLE_DAYS = [3, 0]
const DEFAULT_SETTLE_TIME = '22:00'

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 每日日常重置时间（不逐日列进时间线，卡片上单独一行说明） */
export const DAILY_RESET_TIME = `${pad(DAILY_RESET_HOUR)}:00`

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateKey(date) {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayLabel(date) {
  return DAY_NAMES[date.getDay()]
}

/** 毫秒 -> “3 天 2 小时” / “2 小时 5 分” / “18 分钟” */
export function fmtCountdown(ms) {
  const totalMinute = Math.max(0, Math.round(ms / 60000))
  const day = Math.floor(totalMinute / 1440)
  const hour = Math.floor((totalMinute % 1440) / 60)
  const minute = totalMinute % 60
  if (day > 0) return `${day} 天${hour ? ` ${hour} 小时` : ''}`
  if (hour > 0) return `${hour} 小时${minute ? ` ${minute} 分` : ''}`
  return `${minute} 分`
}

function timeParts(value = DEFAULT_SETTLE_TIME) {
  const [hour, minute] = String(value).split(':').map(Number)
  return {
    hour: Number.isFinite(hour) ? hour : 22,
    minute: Number.isFinite(minute) ? minute : 0,
  }
}

/**
 * 列出从 now 开始 days 天内的所有周期节点
 * @param {Date} [now]
 * @param {{days?: number, settleTime?: string}} [options]
 * @returns {Array<{at: Date, dateText: string, weekday: string, timeText: string, title: string, tag: string, countdown: string}>}
 */
export function buildCalendarEvents(now = new Date(), { days = 7, settleTime = DEFAULT_SETTLE_TIME } = {}) {
  const events = []
  const settle = timeParts(settleTime)
  const endTime = now.getTime() + days * 24 * 60 * 60 * 1000

  const push = (at, title, tag) => {
    if (at.getTime() < now.getTime() || at.getTime() > endTime) return
    events.push({
      at,
      dateText: dateKey(at),
      weekday: dayLabel(at),
      timeText: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
      title,
      tag,
      countdown: fmtCountdown(at.getTime() - now.getTime()),
    })
  }

  for (let offset = 0; offset <= days; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const weekday = day.getDay()

    // 日常重置每天都有，放在卡片顶部统一说明，不逐日塞进时间线
    if (weekday === WEEKLY_RESET_DAY) {
      push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAILY_RESET_HOUR, 0), '周常重置（记忆战场 / 往世乐土 / 周奖励）', '重置')
    }
    if (ABYSS_OPEN_DAYS.includes(weekday)) {
      push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), ABYSS_OPEN_HOUR, 0), '超弦空间开放', '开放')
    }
    if (ABYSS_SETTLE_DAYS.includes(weekday)) {
      push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), settle.hour, settle.minute), '超弦空间结算', '结算')
    }
  }

  events.sort((a, b) => a.at - b.at)
  return events
}
