import fs from 'fs'
import path from 'path'
import { Bh3Plugin } from './apps/main.js'
import { scheduleCharacterAutoUpdate } from './lib/characterUpdater.js'
import { schedulePushReminder } from './lib/push.js'
import { scheduleCalendarSubs } from './lib/calendarSub.js'
import { fetchAnnouncements } from './lib/announcement.js'

if (!globalThis.segment) {
  const oicq = await import('oicq')
  globalThis.segment = oicq.segment
}

const dataDir = path.join(process.cwd(), 'data', 'bh3')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

if (globalThis.logger?.info) {
  globalThis.logger.info('崩坏3查询插件加载中...')
}

// 启动后自动检查女武神数据库，过期或缺失时在后台从米游社图鉴重新抓取（不阻塞 Bot 启动）
scheduleCharacterAutoUpdate()

// 周常提醒：周日检查 + 深渊结算前 1.5 小时（默认关闭，用 #崩坏3推送 开启）
schedulePushReminder(globalThis.logger)

// 活动日历订阅：每天到点推送当日日历 + 活动快结束时单独提醒
scheduleCalendarSubs(globalThis.logger)

// 活动日历数据：启动后预热一次公告缓存，避免第一条 #崩坏3活动日历 等太久
if (globalThis.__bh3CalendarWarmup !== true) {
  globalThis.__bh3CalendarWarmup = true
  const warmup = setTimeout(() => {
    fetchAnnouncements().catch(error => {
      globalThis.logger?.warn?.(`[bh3] 公告缓存预热失败：${error.message}`)
    })
  }, 15 * 1000)
  warmup.unref?.()
}

const apps = { Bh3Plugin }

export { apps }
