import fs from 'node:fs'
import path from 'node:path'
import { recordRequest } from './api.js'
import { getCookie } from './store.js'

const CONFIG_FILE = path.join(process.cwd(), 'data', 'bh3', 'push.json')
const STATE_FILE = path.join(process.cwd(), 'data', 'bh3', 'push-state.json')
const CHECK_INTERVAL_MS = 30 * 1000
const MAX_ATTEMPTS_PER_SLOT = 3
const SETTLE_REMIND_BEFORE_MIN = 90

/** 周常检查的三个模式 */
const MODE_LABEL = { abyss: '深渊', battlefield: '战场', godwar: '乐土' }
const MODE_NAME = { abyss: '深渊（超弦空间）', battlefield: '战场（记忆战场）', godwar: '乐土（往世乐土）' }
const VALID_MODES = Object.keys(MODE_LABEL)

const DEFAULT_CONFIG = {
  enabled: false,
  uid: '',
  at: '',
  modes: ['abyss', 'battlefield', 'godwar'],
  targets: [{ type: 'master' }],
  sundayTime: '08:00',
  settleTime: '04:00',
}

const flagOn = value => /^(1|true|on|yes)$/i.test(String(value ?? '').trim())

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (error) {
    globalThis.logger?.warn?.(`[bh3] 写入 ${path.basename(file)} 失败: ${error.message}`)
  }
}

function parseTargets(value = '') {
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      if (item === 'master') return { type: 'master' }
      const match = item.match(/^(group|friend):(\d+)$/)
      return match ? { type: match[1], id: match[2] } : null
    })
    .filter(Boolean)
}

function normalizeModes(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，\s]+/)
  const modes = list.map(item => String(item).trim()).filter(item => VALID_MODES.includes(item))
  return modes.length ? [...new Set(modes)] : [...DEFAULT_CONFIG.modes]
}

function normalizeConfig(config = {}) {
  const next = { ...DEFAULT_CONFIG, ...config }
  next.modes = normalizeModes(next.modes)
  if (!Array.isArray(next.targets) || next.targets.length === 0) next.targets = [{ type: 'master' }]
  if (!isValidTime(next.sundayTime)) next.sundayTime = DEFAULT_CONFIG.sundayTime
  if (!isValidTime(next.settleTime)) next.settleTime = DEFAULT_CONFIG.settleTime
  next.uid = String(next.uid || '').trim()
  next.at = String(next.at || '').trim()
  return next
}

/** 读取推送配置：文件为底，环境变量优先（便于容器部署时不改文件） */
export function readPushConfig() {
  const config = normalizeConfig(readJson(CONFIG_FILE, {}))
  const env = process.env
  if (env.BH3_PUSH_ENABLED !== undefined) config.enabled = flagOn(env.BH3_PUSH_ENABLED)
  if (env.BH3_PUSH_UID) config.uid = String(env.BH3_PUSH_UID).trim()
  if (env.BH3_PUSH_AT) config.at = String(env.BH3_PUSH_AT).trim()
  if (env.BH3_PUSH_MODES) config.modes = normalizeModes(env.BH3_PUSH_MODES)
  if (env.BH3_PUSH_SUNDAY_TIME) config.sundayTime = String(env.BH3_PUSH_SUNDAY_TIME).trim()
  if (env.BH3_PUSH_SETTLE_TIME) config.settleTime = String(env.BH3_PUSH_SETTLE_TIME).trim()
  if (env.BH3_PUSH_TARGETS) {
    const targets = parseTargets(env.BH3_PUSH_TARGETS)
    if (targets.length) config.targets = targets
  }
  return normalizeConfig(config)
}

/** 合并写入推送配置（环境变量覆盖的字段在运行时可能不生效，状态里会标注） */
export function writePushConfig(patch = {}) {
  const current = normalizeConfig(readJson(CONFIG_FILE, {}))
  const next = normalizeConfig({ ...current, ...patch })
  writeJson(CONFIG_FILE, next)
  return readPushConfig()
}

export function isValidTime(value = '') {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value).trim())
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateKey(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function timeParts(value = '00:00') {
  const [hour, minute] = String(value).split(':').map(Number)
  return { hour: Number.isFinite(hour) ? hour : 0, minute: Number.isFinite(minute) ? minute : 0 }
}

/** 本期开始：最近的周一 settleTime（例如周一 04:00） */
function periodStart(now, settleTime) {
  const { hour, minute } = timeParts(settleTime)
  const start = new Date(now)
  const day = start.getDay() // 0=周日, 1=周一 ...
  const sinceMonday = (day + 6) % 7
  start.setDate(start.getDate() - sinceMonday)
  start.setHours(hour, minute, 0, 0)
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 7)
  return start
}

/** 本期的两个检查点：周日检查 + 结算前 1.5 小时 */
export function periodChecks(now = new Date(), config = readPushConfig()) {
  const start = periodStart(now, config.settleTime)
  const sunday = timeParts(config.sundayTime)
  const sundayAt = new Date(start)
  sundayAt.setDate(sundayAt.getDate() + 6)
  sundayAt.setHours(sunday.hour, sunday.minute, 0, 0)

  const settleAt = new Date(start)
  settleAt.setDate(settleAt.getDate() + 7)
  const settleReminderAt = new Date(settleAt.getTime() - SETTLE_REMIND_BEFORE_MIN * 60 * 1000)

  return [
    { kind: 'sunday', at: sundayAt, label: `周日 ${config.sundayTime} 检查` },
    {
      kind: 'settle',
      at: settleReminderAt,
      label: `结算前 ${SETTLE_REMIND_BEFORE_MIN} 分钟（周一 ${config.settleTime} 结算）`,
      settleAt,
    },
  ]
}

function readState() {
  return readJson(STATE_FILE, { slots: {} })
}

function writeState(state) {
  const entries = Object.entries(state.slots || {})
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .slice(0, 20)
  writeJson(STATE_FILE, { slots: Object.fromEntries(entries) })
}

export function pushStatusText(now = new Date()) {
  const config = readPushConfig()
  const state = readState()
  const targets = config.targets
    .map(target => (target.type === 'master' ? '主人私聊' : `${target.type === 'group' ? '群' : '好友'} ${target.id}`))
    .join('、')
  const envNote = Object.keys(process.env).some(key => key.startsWith('BH3_PUSH_')) ? '（部分字段被环境变量覆盖）' : ''
  const modeText = config.modes.map(mode => MODE_LABEL[mode]).join('、')
  const checks = periodChecks(now, config)
  const lines = [
    `周常提醒：${config.enabled ? '已开启' : '已关闭'}${envNote}`,
    `检查时间：周日 ${config.sundayTime}；深渊结算（周一 ${config.settleTime}）前 ${SETTLE_REMIND_BEFORE_MIN} 分钟`,
    `检查内容：${modeText}`,
    `目标：${targets}`,
    `UID：${config.uid || '未设置（用 #崩坏3推送 UID <uid> 设置）'}`,
    `群提醒 @：${config.at ? config.at : '未设置（用 #崩坏3推送 @ <QQ号> 设置）'}`,
  ]
  const last = checks
    .map(check => state.slots?.[`${dateKey(check.at)}-${check.kind}`])
    .filter(Boolean)
    .pop()
  if (last) {
    lines.push(`上次：${last.status === 'success' ? '成功' : `失败（${last.message || '未知原因'}）`} · ${last.updatedAt || ''}`)
  }
  lines.push('', '用法：#崩坏3推送 开启 / 关闭 / UID <uid> / 内容 深渊|战场|乐土|全部 / @ <QQ号> / 目标 主人|群 <号>|好友 <号> / 周日 HH:mm / 结算 HH:mm / 测试')
  return lines.join('\n')
}

function settledValue(result) {
  return result.status === 'fulfilled' ? result.value : null
}

function latestTime(list = [], keys = []) {
  let latest = 0
  for (const item of list) {
    for (const key of keys) {
      const value = Number(item?.[key])
      if (value > latest) latest = value
    }
  }
  return latest
}

/**
 * 查询本期参与情况
 * @returns {Promise<{missing: string[], unknown: string[], detail: object}>}
 */
async function fetchParticipation(config, now = new Date()) {
  const uid = String(config.uid || '').trim()
  if (!uid) throw new Error('未设置推送 UID，请先发送 #崩坏3推送 UID <uid>')
  const cookie = getCookie(uid)
  if (!cookie) throw new Error(`UID ${uid} 未配置 Cookie，请先在私聊发送 #崩坏3cookie ${uid} <cookie> 绑定`)

  const weekStartSec = Math.floor(periodStart(now, config.settleTime).getTime() / 1000)
  const results = await Promise.allSettled([
    recordRequest('/newAbyssReport', uid, {}, cookie),
    recordRequest('/latestOldAbyssReport', uid, {}, cookie),
    recordRequest('/battleFieldReport', uid, {}, cookie),
    recordRequest('/godWar', uid, {}, cookie),
  ])
  const [newAbyss, oldAbyss, battlefield, godWar] = results.map(settledValue)
  const failed = {
    abyss: results[0].status === 'rejected' && results[1].status === 'rejected',
    battlefield: results[2].status === 'rejected',
    godwar: results[3].status === 'rejected',
  }

  const abyssReports = [...(newAbyss?.reports || []), ...(oldAbyss?.reports || [])]
  const abyssTime = latestTime(abyssReports, ['settle_time_second', 'updated_time_second', 'time_second'])
  const battlefieldTime = latestTime(battlefield?.reports || [], ['time_second', 'settle_time_second'])
  const godWarTime = latestTime(godWar?.records || [], ['settle_time_second', 'time_second'])

  const detail = {
    abyss: { time: abyssTime, participated: abyssTime > weekStartSec },
    battlefield: { time: battlefieldTime, participated: battlefieldTime > weekStartSec },
    godwar: { time: godWarTime, participated: godWarTime > weekStartSec },
  }
  const missing = []
  const unknown = []
  for (const mode of config.modes) {
    if (failed[mode]) {
      unknown.push(mode)
    } else if (!detail[mode].participated) {
      missing.push(mode)
    }
  }
  return { missing, unknown, detail, uid }
}

function reminderText(config, missing) {
  const names = missing.map(mode => MODE_NAME[mode]).join('、')
  return `你本期还没有参与：${names}。\n深渊 / 战场 / 乐土将在周一 ${config.settleTime} 结算，记得尽快完成～`
}

function buildMessage(config, target, missing, kind) {
  const text = reminderText(config, missing)
  const title = kind === 'settle'
    ? `⏰ 结算前 ${SETTLE_REMIND_BEFORE_MIN} 分钟提醒`
    : '📅 周日周常检查'
  const lines = [`【崩坏3】${title}`, text]
  if (config.uid) lines.push(`（UID ${config.uid}）`)
  const body = lines.join('\n')
  if (target.type === 'group' && config.at && globalThis.segment?.at) {
    return [globalThis.segment.at(String(config.at)), ` ${body}`]
  }
  return body
}

async function sendToTargets(config, missing, kind) {
  const bot = globalThis.Bot
  if (!bot) throw new Error('Bot 尚未就绪')
  const botId = bot.uin?.[0]
  let sent = 0
  for (const target of config.targets) {
    const message = buildMessage(config, target, missing, kind)
    if (target.type === 'master') {
      await bot.sendMasterMsg(message)
      sent += 1
    } else if (target.type === 'group' && target.id) {
      if (!botId) throw new Error('没有可用的 Bot 账号')
      await bot.sendGroupMsg(botId, target.id, message)
      sent += 1
    } else if (target.type === 'friend' && target.id) {
      if (!botId) throw new Error('没有可用的 Bot 账号')
      await bot.sendFriendMsg(botId, target.id, message)
      sent += 1
    }
  }
  return sent
}

/**
 * 检查本期参与情况并提醒
 * @param {{logger?: object, force?: boolean, kind?: 'sunday'|'settle', now?: Date, config?: object}} options
 * @returns {Promise<{uid: string, missing: string[], targets: number, skipped?: boolean}>}
 */
export async function runReminder({ logger = globalThis.logger, force = false, kind = 'sunday', now = new Date(), config = readPushConfig() } = {}) {
  if (!config.enabled && !force) throw new Error('定时提醒未开启，请先发送 #崩坏3推送 开启')
  const result = await fetchParticipation(config, now)
  if (result.missing.length === 0) {
    logger?.info?.(`[bh3] 周常检查：UID ${result.uid} 本期已全部参与`)
    return { uid: result.uid, missing: [], targets: 0, skipped: true }
  }
  const targets = await sendToTargets(config, result.missing, kind)
  logger?.info?.(`[bh3] 周常提醒：UID ${result.uid} 未参与 ${result.missing.map(mode => MODE_LABEL[mode]).join('、')}，已发送 ${targets} 个目标`)
  return { uid: result.uid, missing: result.missing, targets }
}

const SLOT_WINDOW_MS = 12 * 60 * 60 * 1000

async function checkAndRun(logger, now = new Date()) {
  const config = readPushConfig()
  if (!config.enabled) return
  const checks = periodChecks(now, config)
  const state = readState()
  for (const check of checks) {
    if (check.kind === 'settle' && check.settleAt && now >= check.settleAt) continue
    if (now < check.at || now - check.at > SLOT_WINDOW_MS) continue
    const key = `${dateKey(check.at)}-${check.kind}`
    const slot = state.slots?.[key] || { attempts: 0, status: 'pending' }
    if (slot.status === 'success' || slot.attempts >= MAX_ATTEMPTS_PER_SLOT) continue
    slot.attempts += 1
    slot.updatedAt = now.toISOString()
    try {
      const result = await runReminder({ logger, kind: check.kind, now, config })
      slot.status = 'success'
      slot.message = result.missing.length
        ? `提醒 ${result.missing.map(mode => MODE_LABEL[mode]).join('、')}`
        : '本期已全部参与'
    } catch (error) {
      slot.status = 'failed'
      slot.message = error.message
      logger?.warn?.(`[bh3] 周常提醒失败（${key} 第 ${slot.attempts} 次）：${error.message}`)
    }
    state.slots = state.slots || {}
    state.slots[key] = slot
    writeState(state)
  }
}

/** 启动周常提醒检查（进程内只启动一次） */
export function schedulePushReminder(logger = globalThis.logger) {
  if (globalThis.__bh3PushScheduler) return
  globalThis.__bh3PushScheduler = true
  const timer = setInterval(() => {
    checkAndRun(logger).catch(error => logger?.warn?.(`[bh3] 周常提醒检查失败：${error.message}`))
  }, CHECK_INTERVAL_MS)
  timer.unref?.()
  const config = readPushConfig()
  logger?.info?.(`[bh3] 周常提醒已加载（${config.enabled ? `周日 ${config.sundayTime} / 结算前 ${SETTLE_REMIND_BEFORE_MIN} 分钟` : '未开启'}）`)
}
