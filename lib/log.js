import fs from 'node:fs'
import path from 'node:path'

/**
 * 崩坏3插件的运行日志落盘。
 * 插件原来的 logger 只写 stdout，进程被 `cmd /c start` 拉起后日志就丢了，
 * 排查定时推送问题时完全看不到痕迹，所以把 [bh3] 相关日志额外写一份文件。
 */
const LOG_FILE = path.join(process.cwd(), 'data', 'bh3', 'bh3.log')
const MAX_BYTES = 2 * 1024 * 1024

function stringify(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 追加一行日志（超过 2MB 自动轮转一次） */
export function fileLog(level, args = []) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      /* 文件还不存在 */
    }
    const time = new Date().toLocaleString('zh-CN', { hour12: false })
    const line = `[${time}] [${level}] ${args.map(stringify).join(' ')}\n`
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

/**
 * 给 logger 套一层：所有以 [bh3] 开头（或带 bh3 前缀）的日志额外落盘。
 * 重复调用不会重复包装。
 */
export function attachFileLog(logger = globalThis.logger) {
  if (!logger || logger.__bh3FileLog) return logger
  for (const level of ['info', 'warn', 'error', 'mark', 'debug']) {
    const origin = logger[level]
    if (typeof origin !== 'function') continue
    logger[level] = (...args) => {
      const first = args.find(arg => typeof arg === 'string') || ''
      // 正常只记 [bh3] 自己的日志；插件管理器报的 bh3-plugin 错误 / 警告也留一份
      const hit = /\[bh3\]/.test(first) || (level === 'error' || level === 'warn') && /bh3-plugin/.test(first)
      if (hit) fileLog(level, args)
      return origin.apply(logger, args)
    }
  }
  logger.__bh3FileLog = true
  return logger
}
