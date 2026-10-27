import fs from 'fs'
import path from 'path'
import { Bh3Plugin } from './apps/main.js'
import { scheduleCharacterAutoUpdate } from './lib/characterUpdater.js'
import { scheduleDailyPush } from './lib/push.js'

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

// 每日战绩推送（默认关闭，用 #崩坏3推送 开启）
scheduleDailyPush(globalThis.logger)

const apps = { Bh3Plugin }

export { apps }
