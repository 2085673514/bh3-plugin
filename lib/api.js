import crypto from 'crypto'
import { getCookie } from './store.js'
import { APP_VERSION_RECORD, SALT_RECORD, SALT_WEB, UA_RECORD } from './apiConfig.js'
import { fetchWithRetry } from './http.js'

const GS_BASE = 'https://api-takumi.mihoyo.com'
const RECORD_BASE = 'https://api-takumi-record.mihoyo.com'
const BH3_API = `${RECORD_BASE}/game_record/app/honkai3rd/api`

/** uid -> { server, ts }，30 分钟后失效，避免 Cookie 换绑后一直用旧区服 */
const SERVER_CACHE_TTL_MS = 30 * 60 * 1000
const serverCache = new Map()

function md5(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex')
}

function buildRecordDS(query = '') {
  const t = String(Math.floor(Date.now() / 1000))
  const r = String(Math.floor(Math.random() * 100000 + 100000))
  const sign = md5(`salt=${SALT_RECORD}&t=${t}&r=${r}&b=&q=${query}`)
  return `${t},${r},${sign}`
}

function buildWebDS() {
  const t = String(Math.floor(Date.now() / 1000))
  const charset = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const r = Array.from({ length: 6 }, () => charset[Math.floor(Math.random() * charset.length)]).join('')
  const sign = md5(`salt=${SALT_WEB}&t=${t}&r=${r}`)
  return `${t},${r},${sign}`
}

function baseHeaders(extra = {}) {
  return {
    'x-rpc-app_version': APP_VERSION_RECORD,
    'X-Requested-With': 'com.mihoyo.hyperion',
    'User-Agent': UA_RECORD,
    'x-rpc-client_type': '5',
    'Referer': 'https://webstatic.mihoyo.com/',
    'Origin': 'https://webstatic.mihoyo.com/',
    ...extra,
  }
}

function buildQuery(params = {}) {
  return Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
}

async function request(url, headers, timeoutMs = 15000) {
  const res = await fetchWithRetry(url, { headers }, { timeoutMs, retries: 1 })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`接口返回异常 (HTTP ${res.status})`)
  }
  return json
}

function retcodeMessage(retcode, message = '') {
  const map = {
    10001: 'Cookie 未配置或已失效，请重新绑定',
    '-100': 'Cookie 已失效，请重新绑定',
    1008: 'UID 与服务器不匹配，请确认区服',
    10102: '账号数据未公开，请前往米游社开启数据公开',
    1034: '触发米游社风控验证码，请稍后重试或更换 Cookie',
    10035: '请求过于频繁，请稍后再试',
    '-51': '未找到该 UID 的绑定信息',
  }
  return map[String(retcode)] || message || `接口错误 (${retcode})`
}

export async function getUserGameRoles(cookie = '') {
  const query = 'game_biz=bh3_cn'
  const headers = baseHeaders({
    Cookie: cookie,
    DS: buildWebDS(),
  })
  const json = await request(`${GS_BASE}/binding/api/getUserGameRolesByCookie?${query}`, headers)
  if (Number(json.retcode) !== 0) {
    throw new Error(retcodeMessage(json.retcode, json.message))
  }
  return Array.isArray(json.data?.list) ? json.data.list : []
}

async function resolveServer(uid, cookie) {
  const key = String(uid)
  const cached = serverCache.get(key)
  if (cached && Date.now() - cached.ts < SERVER_CACHE_TTL_MS) return cached.server
  const roles = await getUserGameRoles(cookie)
  const role = roles.find(item => String(item.game_uid) === key)
  const server = role?.region || 'android01'
  serverCache.set(key, { server, ts: Date.now() })
  return server
}

export async function recordRequest(endpoint, uid, extraParams = {}, cookie = '') {
  const ck = cookie || getCookie(uid)
  if (!ck) {
    throw new Error('未配置 Cookie，请先使用 #崩坏3cookie 绑定')
  }
  const server = await resolveServer(uid, ck)
  const params = {
    role_id: String(uid),
    server,
    ...extraParams,
  }
  const query = buildQuery(params)
  const headers = baseHeaders({
    Cookie: ck,
    DS: buildRecordDS(query),
  })
  const json = await request(`${BH3_API}${endpoint}?${query}`, headers)
  if (Number(json.retcode) !== 0) {
    throw new Error(retcodeMessage(json.retcode, json.message))
  }
  return json.data || {}
}

export { BH3_API }
