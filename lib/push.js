import fs from 'node:fs'
import path from 'node:path'
import { recordRequest } from './api.js'
import { getCookie } from './store.js'
import { buildAbyssBoard, buildBattleFieldBoard } from './mys/card.js'
import { renderMysTemplate } from './mys/render.js'

const CONFIG_FILE = path.join(process.cwd(), 'data', 'bh3', 'push.json')
const STATE_FILE = path.join(process.cwd(), 'data', 'bh3', 'push-state.json')
const CHECK_INTERVAL_MS = 30 * 1000
const MAX_ATTEMPTS_PER_DAY = 3

const DEFAULT_CONFIG = {
  enabled: false,
  time: '21:30',
  uid: '',
  content: 'both',
  targets: [{ type: 'master' }],
}

const CONTENT_LABEL = { abyss: '深渊', battlefield: '战场', both: '深渊 + 战场' }

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

/** 读取推送配置：文件为底，环境变量优先（便于容器部署时不改文件） */
export function readPushConfig() {
  const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) }
  if (!Array.isArray(config.targets) || config.targets.length === 0) config.targets = [{ type: 'master' }]
  const env = process.env
  if (env.BH3_PUSH_ENABLED !== undefined) config.enabled = flagOn(env.BH3_PUSH_ENABLED)
  if (env.BH3_PUSH_TIME) config.time = String(env.BH3_PUSH_TIME)
  if (env.BH3_PUSH_UID) config.uid = String(env.BH3_PUSH_UID)
  if (env.BH3_PUSH_CONTENT) config.content = String(env.BH3_PUSH_CONTENT)
  if (env.BH3_PUSH_TARGETS) {
    const targets = parseTargets(env.BH3_PUSH_TARGETS)
    if (targets.length) config.targets = targets
  }
  if (!CONTENT_LABEL[config.content]) config.content = 'both'
  return config
}

/** 合并写入推送配置（环境变量覆盖的字段在运行时可能不生效，状态里会标注） */
export function writePushConfig(patch = {}) {
  const current = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) }
  const next = { ...current, ...patch }
  if (!Array.isArray(next.targets) || next.targets.length === 0) next.targets = [{ type: 'master' }]
  if (!CONTENT_LABEL[next.content]) next.content = 'both'
  writeJson(CONFIG_FILE, next)
  return readPushConfig()
}

export function isValidTime(value = '') {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value).trim())
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function readState() {
  return readJson(STATE_FILE, {})
}

function writeState(state) {
  writeJson(STATE_FILE, state)
}

export function pushStatusText() {
  const config = readPushConfig()
  const state = readState()
  const targets = config.targets
    .map(target => (target.type === 'master' ? '主人私聊' : `${target.type === 'group' ? '群' : '好友'} ${target.id}`))
    .join('、')
  const envNote = Object.keys(process.env).some(key => key.startsWith('BH3_PUSH_')) ? '（部分字段被环境变量覆盖）' : ''
  const lines = [
    `定时推送：${config.enabled ? '已开启' : '已关闭'}${envNote}`,
    `时间：每天 ${config.time}`,
    `推送内容：${CONTENT_LABEL[config.content]}`,
    `目标：${targets}`,
    `UID：${config.uid || '未设置（用 #崩坏3推送 UID <uid> 设置）'}`,
  ]
  if (state.updatedAt) {
    lines.push(`上次：${state.date || ''} ${state.status === 'success' ? '成功' : `失败（${state.message || '未知原因'}）`}`)
  }
  lines.push('', '用法：#崩坏3推送 开启 [HH:mm] / 关闭 / UID <uid> / 内容 深渊|战场|全部 / 目标 主人|群 <号>|好友 <号> / 测试')
  return lines.join('\n')
}

function settleValue(result) {
  return result.status === 'fulfilled' ? result.value : null
}

async function fetchPushRaw(uid, cookie) {
  const [index, newAbyss, oldAbyss, battlefield] = await Promise.allSettled([
    recordRequest('/index', uid, {}, cookie),
    recordRequest('/newAbyssReport', uid, {}, cookie),
    recordRequest('/latestOldAbyssReport', uid, {}, cookie),
    recordRequest('/battleFieldReport', uid, {}, cookie),
  ])
  const raw = {
    index: settleValue(index),
    newAbyssReport: settleValue(newAbyss),
    latestOldAbyssReport: settleValue(oldAbyss),
    battleFieldReport: settleValue(battlefield),
  }
  if (!raw.index?.role) {
    const reason = index.status === 'rejected' ? index.reason?.message : '账号数据为空'
    throw new Error(reason || '获取账号数据失败')
  }
  return raw
}

async function buildPushImages(config, raw, uid) {
  const role = raw.index?.role || {}
  const server = role.region || ''
  const images = []
  if (config.content !== 'battlefield') {
    const board = buildAbyssBoard(raw, { uid, server, nickname: role.nickname })
    if (!board.empty) {
      images.push(await renderMysTemplate('bh3abyssnow', board, { deviceScaleFactor: 1.6, quality: 82, waitImages: 7000 }))
    }
  }
  if (config.content !== 'abyss') {
    const board = buildBattleFieldBoard(raw, { uid, server, nickname: role.nickname })
    if (!board.empty) {
      images.push(await renderMysTemplate('bh3battlefield', board, { deviceScaleFactor: 1.6, quality: 82, waitImages: 7000 }))
    }
  }
  return images
}

async function sendToTargets(config, message) {
  const bot = globalThis.Bot
  if (!bot) throw new Error('Bot 尚未就绪')
  const botId = bot.uin?.[0]
  let sent = 0
  for (const target of config.targets) {
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
 * 执行一次推送
 * @param {{logger?: object, force?: boolean, config?: object}} options
 * @returns {Promise<{uid: string, images: number, targets: number}>}
 */
export async function runPush({ logger = globalThis.logger, force = false, config = readPushConfig() } = {}) {
  if (!config.enabled && !force) throw new Error('定时推送未开启')
  const uid = String(config.uid || '').trim()
  if (!uid) throw new Error('未设置推送 UID，请先发送 #崩坏3推送 UID <uid>')
  const cookie = getCookie(uid)
  if (!cookie) throw new Error('该 UID 未配置 Cookie，请先在私聊发送 #崩坏3cookie <uid> <cookie> 绑定')

  const raw = await fetchPushRaw(uid, cookie)
  const images = await buildPushImages(config, raw, uid)
  if (images.length === 0) throw new Error('没有可推送的战绩数据')

  const segment = globalThis.segment
  if (!segment?.image) throw new Error('图片消息组件未初始化，无法发送图片')
  const caption = `崩坏3 每日战绩推送 · UID ${uid}`
  await sendToTargets(config, caption)
  for (const image of images) {
    await sendToTargets(config, segment.image(image))
  }
  logger?.info?.(`[bh3] 定时推送完成：UID ${uid}，${images.length} 张图，${config.targets.length} 个目标`)
  return { uid, images: images.length, targets: config.targets.length }
}

async function checkAndPush(logger) {
  const config = readPushConfig()
  if (!config.enabled) return
  const now = new Date()
  const current = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  if (current < config.time) return

  const date = today(now)
  let state = readState()
  if (state.date !== date) state = { date, attempts: 0 }
  if (state.status === 'success' || state.attempts >= MAX_ATTEMPTS_PER_DAY) return

  state.attempts += 1
  state.updatedAt = new Date().toISOString()
  try {
    const result = await runPush({ logger, config })
    state.status = 'success'
    state.message = `${result.images} 张图 -> ${result.targets} 个目标`
  } catch (error) {
    state.status = 'failed'
    state.message = error.message
    logger?.warn?.(`[bh3] 定时推送失败（第 ${state.attempts} 次）：${error.message}`)
  }
  writeJson(STATE_FILE, state)
}

/** 启动每日推送检查（进程内只启动一次） */
export function scheduleDailyPush(logger = globalThis.logger) {
  if (globalThis.__bh3PushScheduler) return
  globalThis.__bh3PushScheduler = true
  const timer = setInterval(() => {
    checkAndPush(logger).catch(error => logger?.warn?.(`[bh3] 定时推送检查失败：${error.message}`))
  }, CHECK_INTERVAL_MS)
  timer.unref?.()
  const config = readPushConfig()
  logger?.info?.(`[bh3] 定时推送已加载（${config.enabled ? `每天 ${config.time}` : '未开启'}）`)
}
