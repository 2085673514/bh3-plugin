import fs from 'node:fs'
import path from 'node:path'
import { recordRequest } from './api.js'
import { getCookie } from './store.js'

const CONFIG_FILE = path.join(process.cwd(), 'data', 'bh3', 'push.json')
const STATE_FILE = path.join(process.cwd(), 'data', 'bh3', 'push-state.json')
const CHECK_INTERVAL_MS = 30 * 1000
const MAX_ATTEMPTS_PER_SLOT = 3
const SLOT_WINDOW_MS = 12 * 60 * 60 * 1000

/** 超弦空间：周一/周四 15:00 开放，周三/周日 22:00 结算 */
const ABYSS_OPEN_TIME = '15:00'
const ABYSS_OPEN_DAYS = [1, 4]
const ABYSS_SETTLE_DAYS = [3, 0]
const SETTLE_REMIND_BEFORE_MIN = 90
/** 记忆战场 / 往世乐土：周一 04:00 周重置 */
const WEEKLY_RESET_TIME = '04:00'

const DEFAULT_CONFIG = {
  enabled: false,
  abyssEnabled: true,
  weeklyEnabled: true,
  uid: '',
  sundayTime: '08:00',
  settleTime: '22:00',
  enabledBy: '',
  targetType: '',
  targetId: '',
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

export function isValidTime(value = '') {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value).trim())
}

function timeParts(value = '00:00') {
  const [hour, minute] = String(value).split(':').map(Number)
  return { hour: Number.isFinite(hour) ? hour : 0, minute: Number.isFinite(minute) ? minute : 0 }
}

function normalizeConfig(config = {}) {
  const next = { ...DEFAULT_CONFIG, ...config }
  next.uid = String(next.uid || '').trim()
  next.enabledBy = String(next.enabledBy || '').trim()
  next.targetType = ['group', 'private'].includes(next.targetType) ? next.targetType : ''
  next.targetId = String(next.targetId || '').trim()
  next.abyssEnabled = next.abyssEnabled !== false && !/^(0|false|off|no)$/i.test(String(next.abyssEnabled))
  next.weeklyEnabled = next.weeklyEnabled !== false && !/^(0|false|off|no)$/i.test(String(next.weeklyEnabled))
  if (!isValidTime(next.sundayTime)) next.sundayTime = DEFAULT_CONFIG.sundayTime
  if (!isValidTime(next.settleTime)) next.settleTime = DEFAULT_CONFIG.settleTime
  return next
}

export function readPushConfig() {
  const config = normalizeConfig(readJson(CONFIG_FILE, {}))
  const env = process.env
  if (env.BH3_PUSH_ENABLED !== undefined) config.enabled = flagOn(env.BH3_PUSH_ENABLED)
  if (env.BH3_PUSH_ABYSS !== undefined) config.abyssEnabled = flagOn(env.BH3_PUSH_ABYSS)
  if (env.BH3_PUSH_WEEKLY !== undefined) config.weeklyEnabled = flagOn(env.BH3_PUSH_WEEKLY)
  if (env.BH3_PUSH_UID) config.uid = String(env.BH3_PUSH_UID).trim()
  if (env.BH3_PUSH_SUNDAY_TIME) config.sundayTime = String(env.BH3_PUSH_SUNDAY_TIME).trim()
  if (env.BH3_PUSH_SETTLE_TIME) config.settleTime = String(env.BH3_PUSH_SETTLE_TIME).trim()
  return normalizeConfig(config)
}

export function writePushConfig(patch = {}) {
  const current = normalizeConfig(readJson(CONFIG_FILE, {}))
  const next = normalizeConfig({ ...current, ...patch })
  writeJson(CONFIG_FILE, next)
  return readPushConfig()
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateKey(value = new Date()) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function atTime(base, hhmm) {
  const { hour, minute } = timeParts(hhmm)
  const value = new Date(base)
  value.setHours(hour, minute, 0, 0)
  return value
}

/** 结算时间往前推 1.5 小时后的时间文本 */
function remindTimeText(settleTime) {
  const { hour, minute } = timeParts(settleTime)
  const total = ((hour * 60 + minute - SETTLE_REMIND_BEFORE_MIN) % 1440 + 1440) % 1440
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** 最近一次「星期 weekday 的 hhmm」；若今天就是且还没到，则取上周 */
function previousWeekday(now, weekday, hhmm) {
  const value = atTime(now, hhmm)
  const diff = (value.getDay() - weekday + 7) % 7
  value.setDate(value.getDate() - diff)
  if (value.getTime() > now.getTime()) value.setDate(value.getDate() - 7)
  return value
}

/** 超弦空间本期开始：最近的周一/周四 15:00 */
function abyssPeriodStart(now) {
  let latest = null
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(now)
    day.setDate(day.getDate() - offset)
    if (!ABYSS_OPEN_DAYS.includes(day.getDay())) continue
    const open = atTime(day, ABYSS_OPEN_TIME)
    if (open.getTime() <= now.getTime() && (!latest || open > latest)) latest = open
  }
  return latest || previousWeekday(now, 1, ABYSS_OPEN_TIME)
}

/** 战场/乐土本周开始：最近的周一 04:00 */
function weekStart(now) {
  return previousWeekday(now, 1, WEEKLY_RESET_TIME)
}

/** 本期内的检查点：周日 08:00 查战场/乐土 + 深渊结算前 90 分钟查深渊 */
export function periodChecks(now = new Date(), config = readPushConfig()) {
  const checks = []
  const sunday = atTime(now, config.sundayTime)
  const sundayDiff = (sunday.getDay() + 7) % 7
  sunday.setDate(sunday.getDate() - sundayDiff)
  if (sunday.getTime() > now.getTime()) sunday.setDate(sunday.getDate() - 7)
  checks.push({ kind: 'weekly', at: sunday, label: `周日 ${config.sundayTime} 检查战场/乐土` })

  const settle = atTime(now, config.settleTime)
  const settleDiff = (settle.getDay() + 7) % 7
  settle.setDate(settle.getDate() - settleDiff)
  if (settle.getTime() > now.getTime()) settle.setDate(settle.getDate() - 7)
  if (!ABYSS_SETTLE_DAYS.includes(settle.getDay())) {
    const next = new Date(now)
    for (let offset = 0; offset < 8; offset += 1) {
      next.setDate(now.getDate() + offset)
      if (ABYSS_SETTLE_DAYS.includes(next.getDay())) break
    }
    settle.setFullYear(next.getFullYear(), next.getMonth(), next.getDate())
    atTime(settle, config.settleTime)
  }
  checks.push({
    kind: 'abyss',
    at: new Date(settle.getTime() - SETTLE_REMIND_BEFORE_MIN * 60 * 1000),
    label: `深渊结算前 ${SETTLE_REMIND_BEFORE_MIN} 分钟（${config.settleTime} 结算）`,
    settleAt: settle,
  })
  return checks
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
  const envNote = Object.keys(process.env).some(key => key.startsWith('BH3_PUSH_')) ? '（部分字段被环境变量覆盖）' : ''
  const lines = [
    `周常提醒：${config.enabled ? '已开启' : '已关闭'}${envNote}`,
    `深渊提醒：${config.abyssEnabled ? '开启' : '关闭'} · 周三 / 周日 ${config.settleTime} 结算前 ${SETTLE_REMIND_BEFORE_MIN} 分钟（${remindTimeText(config.settleTime)}）`,
    `战场/乐土提醒：${config.weeklyEnabled ? '开启' : '关闭'} · 周日 ${config.sundayTime}`,
    `提醒对象：${config.targetType === 'group' && config.targetId
      ? `群 ${config.targetId} @ ${config.enabledBy || '未记录'}`
      : config.enabledBy ? `私聊 ${config.enabledBy}` : '未记录（重新发送 #崩坏3推送 开启）'}`,
    `UID：${config.uid || '未设置（用 #崩坏3推送 UID <uid> 设置）'}`,
  ]
  const last = Object.values(state.slots || {})
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
  if (last) {
    lines.push(`上次：${last.status === 'success' ? '成功' : `失败（${last.message || '未知原因'}）`} · ${last.updatedAt || ''}`)
  }
  lines.push('', '用法：#崩坏3推送 状态 / 开启 / 关闭 / UID <uid> / 测试')
  lines.push('　　　#崩坏3推送深渊 [HH:mm|开启|关闭]　#崩坏3推送战场/乐土 [HH:mm|开启|关闭]')
  return lines.join('\n')
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

async function fetchParticipation(config, now = new Date()) {
  const uid = String(config.uid || '').trim()
  if (!uid) throw new Error('未设置推送 UID，请先发送 #崩坏3推送 UID <uid>')
  const cookie = getCookie(uid)
  if (!cookie) throw new Error(`UID ${uid} 未配置 Cookie，请先在私聊发送 #崩坏3cookie ${uid} <cookie> 绑定`)

  const results = await Promise.allSettled([
    recordRequest('/newAbyssReport', uid, {}, cookie),
    recordRequest('/latestOldAbyssReport', uid, {}, cookie),
    recordRequest('/battleFieldReport', uid, {}, cookie),
    recordRequest('/godWar', uid, {}, cookie),
  ])
  const [newAbyss, oldAbyss, battlefield, godWar] = results.map(result => (result.status === 'fulfilled' ? result.value : null))
  const failed = {
    abyss: results[0].status === 'rejected' && results[1].status === 'rejected',
    battlefield: results[2].status === 'rejected',
    godwar: results[3].status === 'rejected',
  }

  const abyssStart = Math.floor(abyssPeriodStart(now).getTime() / 1000)
  const weeklyStart = Math.floor(weekStart(now).getTime() / 1000)
  const abyssTime = latestTime([...(newAbyss?.reports || []), ...(oldAbyss?.reports || [])], ['settle_time_second', 'updated_time_second', 'time_second'])
  const battlefieldTime = latestTime(battlefield?.reports || [], ['time_second', 'settle_time_second'])
  const godWarTime = latestTime(godWar?.records || [], ['settle_time_second', 'time_second'])

  return {
    uid,
    failed,
    abyss: abyssTime > abyssStart,
    battlefield: battlefieldTime > weeklyStart,
    godwar: godWarTime > weeklyStart,
  }
}

/**
 * 检查并发送提醒
 * @param {{logger?: object, force?: boolean, kind?: 'abyss'|'weekly'|'all', now?: Date, config?: object}} options
 */
export async function runReminder({ logger = globalThis.logger, force = false, kind = 'all', now = new Date(), config = readPushConfig() } = {}) {
  if (!config.enabled && !force) throw new Error('定时提醒未开启，请先发送 #崩坏3推送 开启')
  if (!force && kind === 'abyss' && !config.abyssEnabled) throw new Error('深渊提醒未开启，请先发送 #崩坏3推送深渊 开启')
  if (!force && kind === 'weekly' && !config.weeklyEnabled) throw new Error('战场/乐土提醒未开启，请先发送 #崩坏3推送战场/乐土 开启')
  const data = await fetchParticipation(config, now)

  const missing = []
  if (kind === 'abyss' || (kind === 'all' && config.abyssEnabled)) {
    if (!data.failed.abyss && !data.abyss) missing.push('abyss')
  }
  if (kind === 'weekly' || (kind === 'all' && config.weeklyEnabled)) {
    if (!data.failed.battlefield && !data.battlefield) missing.push('battlefield')
    if (!data.failed.godwar && !data.godwar) missing.push('godwar')
  }

  if (missing.length === 0) {
    logger?.info?.(`[bh3] 周常提醒：UID ${data.uid} 本期已全部参与，跳过`)
    return { uid: data.uid, missing: [], skipped: true }
  }

  const names = { abyss: '深渊（超弦空间）', battlefield: '战场（记忆战场）', godwar: '乐土（往世乐土）' }
  const list = missing.map(mode => names[mode]).join('、')
  const title = kind === 'abyss'
    ? `⏰ 深渊结算提醒（${config.settleTime} 结算）`
    : '📅 周常参与检查'
  const lines = [`【崩坏3】${title}`, `你本期还没有参与：${list}。`]
  if (missing.includes('abyss')) lines.push(`超弦空间将在 ${config.settleTime} 结算，记得尽快完成～`)
  if (missing.includes('battlefield') || missing.includes('godwar')) lines.push('记忆战场周一 04:00 结算，往世乐土周常也别忘了～')
  if (config.uid) lines.push(`（UID ${config.uid}）`)

  const bot = globalThis.Bot
  if (!bot) throw new Error('Bot 尚未就绪')
  if (!config.enabledBy) {
    throw new Error('没有记录开启推送的用户，请重新发送 #崩坏3推送 开启')
  }
  const text = lines.join('\n')
  if (config.targetType === 'group' && config.targetId) {
    const at = globalThis.segment?.at
    const message = at ? [at(String(config.enabledBy)), ' ', text] : text
    await bot.sendGroupMsg(bot.uin?.[0], config.targetId, message)
    logger?.info?.(`[bh3] 周常提醒：UID ${data.uid} 未参与 ${list}，已在群 ${config.targetId} @ ${config.enabledBy}`)
  } else {
    await bot.sendFriendMsg(bot.uin?.[0], config.enabledBy, text)
    logger?.info?.(`[bh3] 周常提醒：UID ${data.uid} 未参与 ${list}，已私聊 ${config.enabledBy}`)
  }
  return { uid: data.uid, missing, skipped: false }
}

async function checkAndRun(logger, now = new Date()) {
  const config = readPushConfig()
  if (!config.enabled) return
  const state = readState()
  const slots = []

  const sunday = atTime(now, config.sundayTime)
  if (now.getDay() === 0) {
    slots.push({ kind: 'weekly', at: sunday, key: `${dateKey(now)}-weekly` })
  }

  if (ABYSS_SETTLE_DAYS.includes(now.getDay())) {
    const settle = atTime(now, config.settleTime)
    const remindAt = new Date(settle.getTime() - SETTLE_REMIND_BEFORE_MIN * 60 * 1000)
    slots.push({ kind: 'abyss', at: remindAt, key: `${dateKey(now)}-abyss`, settleAt: settle })
  }

  for (const slot of slots) {
    if (slot.kind === 'abyss' && !config.abyssEnabled) continue
    if (slot.kind === 'weekly' && !config.weeklyEnabled) continue
    if (slot.settleAt && now >= slot.settleAt) continue
    if (now < slot.at || now - slot.at > SLOT_WINDOW_MS) continue
    const entry = state.slots?.[slot.key] || { attempts: 0, status: 'pending' }
    if (entry.status === 'success' || entry.attempts >= MAX_ATTEMPTS_PER_SLOT) continue
    entry.attempts += 1
    entry.updatedAt = now.toISOString()
    try {
      const result = await runReminder({ logger, kind: slot.kind, now, config })
      entry.status = 'success'
      entry.message = result.skipped ? '已全部参与' : '已提醒'
    } catch (error) {
      entry.status = 'failed'
      entry.message = error.message
      logger?.warn?.(`[bh3] 周常提醒失败（${slot.key} 第 ${entry.attempts} 次）：${error.message}`)
    }
    state.slots = state.slots || {}
    state.slots[slot.key] = entry
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
  const remind = timeParts(config.settleTime)
  const remindMinute = remind.hour * 60 + remind.minute - SETTLE_REMIND_BEFORE_MIN
  const remindText = `${pad(Math.floor(remindMinute / 60))}:${pad(remindMinute % 60)}`
  logger?.info?.(`[bh3] 周常提醒已加载（${config.enabled ? `周日 ${config.sundayTime} 查战场/乐土，周三/周日 ${remindText} 查深渊` : '未开启'}）`)
}
