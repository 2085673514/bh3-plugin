import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { APP_VERSION_MYS as APP_VERSION, SALT_RECORD as SALT, UA_MYS as UA, WEB_UA } from "../apiConfig.js"
import { fetchWithRetry } from "../http.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RECORD_BASE = "https://api-takumi-record.mihoyo.com/game_record/app/honkai3rd/api"
const BINDING_URL = "https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie"
const CARD_URL = "https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/getGameRecordCard"

export class InfoError extends Error {
  constructor(msg) {
    super(msg)
    this.name = "InfoError"
  }
}

/** 生成米游社DS签名 */
export function ds(q = "", b = "") {
  const t = Math.floor(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const hash = crypto
    .createHash("md5")
    .update(`salt=${SALT}&t=${t}&r=${r}&b=${b}&q=${q}`)
    .digest("hex")
  return `${t},${r},${hash}`
}

let _region = null
/** 读取渠道配置 */
export function loadRegion() {
  if (_region) return _region
  _region = JSON.parse(fs.readFileSync(path.join(__dirname, "region.json"), "utf8"))
  return _region
}

/** 服务器名 -> 渠道代码 */
export function server2id(no = "") {
  no = String(no).toLowerCase().trim()
  if (no.endsWith("服")) no = no.slice(0, -1)
  const region = loadRegion()
  for (const [id, info] of Object.entries(region)) {
    if (no === info.name || info.alias.includes(no)) return id
  }
  throw new InfoError(`找不到渠道「${no}」的数据，可尝试输入账号所在的服务器，如 官服 / b服 / 桌面服`)
}

/** 渠道代码 -> 服务器名 */
export function id2server(regionId) {
  const region = loadRegion()
  const info = region[regionId]
  return info ? info.name : regionId || "未知"
}

/** 段位 */
export function abyssLevel(no) {
  if (no === null || no === undefined || no === "") return "无数据"
  const map = {
    0: "未战斗",
    1: "禁忌",
    2: "原罪Ⅰ",
    3: "原罪Ⅱ",
    4: "原罪Ⅲ",
    5: "苦痛Ⅰ",
    6: "苦痛Ⅱ",
    7: "苦痛Ⅲ",
    8: "红莲",
    9: "寂灭",
    A: "红莲",
    B: "苦痛",
    C: "原罪",
    D: "禁忌",
  }
  if (String(no).startsWith("Unknown")) return "无数据"
  return map[no] ?? `段位${no}`
}

/** 区域 */
export function areaName(no) {
  const level = ["初级区", "中级区", "高级区", "终极区"]
  if (!no) return "初级区"
  return level[no - 1] || level[0]
}

/** 时间(秒时间戳或日期字符串) -> 日期字符串 */
export function fmtDate(sec) {
  if (sec === null || sec === undefined || sec === "") return ""
  const raw = String(sec).trim()
  let d
  if (/^\d+(\.\d+)?$/.test(raw)) {
    // 秒时间戳；兼容误传的毫秒时间戳
    const n = Number(raw)
    d = new Date(n > 1e12 ? n : n * 1000)
  } else {
    d = new Date(raw.replace(" ", "T"))
  }
  if (!d || Number.isNaN(d.getTime())) return ""
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 时间(秒时间戳或日期字符串) -> 日期时间字符串 */
export function fmtDateTime(sec) {
  if (sec === null || sec === undefined || sec === "") return ""
  const raw = String(sec).trim()
  let d
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    d = new Date(n > 1e12 ? n : n * 1000)
  } else {
    d = new Date(raw.replace(" ", "T"))
  }
  if (!d || Number.isNaN(d.getTime())) return ""
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`
}

/** 崩坏3游戏记录API */
export class Bh3 {
  /**
   * @param cookie 米游社cookie(取自yunzai用户绑定)
   */
  constructor(cookie = "") {
    this.cookie = cookie
  }

  headers(q = "") {
    const h = {
      DS: ds(q),
      "x-rpc-app_version": APP_VERSION,
      "User-Agent": UA,
      "x-rpc-client_type": "5",
      Referer: "https://webstatic.mihoyo.com/",
    }
    if (this.cookie) h.Cookie = this.cookie
    return h
  }

  async req(url, q = "") {
    let res
    try {
      res = await fetchWithRetry(url, { headers: this.headers(q) }, { timeoutMs: 20000, retries: 1 })
    } catch (e) {
      throw new InfoError("网络请求失败，请稍后再试")
    }
    if (!res.ok) throw new InfoError(`米游社接口异常：HTTP ${res.status}`)
    return await res.json()
  }

  /** 请求并检查retcode */
  async api(url, q = "") {
    const data = await this.req(url, q)
    const retcode = Number(data.retcode)
    if (retcode === 0) return data
    // -1 为接口偶发异常：只有确实带 data 时才按成功处理，否则交由调用方报错
    if (retcode === -1) {
      if (data.data !== undefined && data.data !== null) return data
      throw new InfoError("米游社接口暂时不可用，请稍后再试")
    }
    if (retcode === 1008) throw new InfoError("uid与服务器不匹配")
    if (retcode === 10102) throw new InfoError("账号数据非公开，请前往米游社开启数据公开")
    if (retcode === 10001 || retcode === -100) throw new InfoError("登录失效，请重新绑定Cookie")
    if (retcode === 1034 || retcode === 10035) throw new InfoError("查询遇到验证码拦截，请稍后再试")
    throw new InfoError(`米游社接口报错：${data.message || JSON.stringify(data).slice(0, 100)}`)
  }

  record(apiName, uid, server) {
    return `${RECORD_BASE}/${apiName}?server=${server}&role_id=${uid}`
  }

  /** 数据总览 */
  async index(uid, server) {
    return (await this.api(this.record("index", uid, server), `role_id=${uid}&server=${server}`)).data
  }

  /** 实时便签(体力/训练/深渊/战场/乐土) */
  async note(uid, server) {
    return (await this.api(this.record("note", uid, server), `role_id=${uid}&server=${server}`)).data
  }

  /** 我的女武神 */
  async characters(uid, server) {
    return (
      await this.api(this.record("characters", uid, server), `role_id=${uid}&server=${server}`)
    ).data
  }

  /** 一周成绩单 */
  async weeklyReport(uid, server) {
    return (
      await this.api(this.record("weeklyReport", uid, server), `role_id=${uid}&server=${server}`)
    ).data
  }

  /** 深渊战报_超弦空间 */
  async newAbyssReport(uid, server) {
    return (
      await this.api(this.record("newAbyssReport", uid, server), `role_id=${uid}&server=${server}`)
    ).data
  }

  /** 深渊战报_latest(高级区及以下) */
  async latestOldAbyssReport(uid, server) {
    return (
      await this.api(
        this.record("latestOldAbyssReport", uid, server),
        `role_id=${uid}&server=${server}`,
      )
    ).data
  }

  /** 战场战报 */
  async battleFieldReport(uid, server) {
    return (
      await this.api(
        this.record("battleFieldReport", uid, server),
        `role_id=${uid}&server=${server}`,
      )
    ).data
  }

  /** 玩家卡片所需数据(不查询角色与乐土,减少开销) */
  async part(uid, server) {
    const [index, weekly, newAbyss, oldAbyss, battle] = await Promise.allSettled([
      this.index(uid, server),
      this.weeklyReport(uid, server),
      this.newAbyssReport(uid, server),
      this.latestOldAbyssReport(uid, server),
      this.battleFieldReport(uid, server),
    ])
    if (index.status !== "fulfilled") {
      throw index.reason
    }
    return {
      index: index.value,
      weeklyReport: weekly.status === "fulfilled" ? weekly.value : null,
      newAbyssReport: newAbyss.status === "fulfilled" ? newAbyss.value : null,
      latestOldAbyssReport: oldAbyss.status === "fulfilled" ? oldAbyss.value : null,
      battleFieldReport: battle.status === "fulfilled" ? battle.value : null,
    }
  }

  /** 网页活动接口：月补给卡数量（失败返回 null，不影响主流程） */
  async handbookCount(uid, server, name) {
    const url = `https://api-takumi.mihoyo.com/event/handbook/${name}?game_biz=bh3_cn&bind_uid=${uid}&bind_region=${server}`
    const headers = {
      "User-Agent": WEB_UA,
      Referer: "https://webstatic.mihoyo.com/",
      Cookie: this.cookie,
    }
    try {
      const res = await fetchWithRetry(url, { headers }, { timeoutMs: 15000, retries: 0 })
      const data = await res.json()
      if (Number(data.retcode) !== 0) return null
      return data.data?.count ?? null
    } catch {
      return null
    }
  }

  /** 收集度：面板数据 + 月补给卡数量 */
  async collect(uid, server) {
    const [index, cardCount, lastCardCount] = await Promise.allSettled([
      this.index(uid, server),
      this.handbookCount(uid, server, "current_month_count"),
      this.handbookCount(uid, server, "last_month_count"),
    ])
    if (index.status !== "fulfilled") throw index.reason
    return {
      index: index.value,
      cardCount: cardCount.status === "fulfilled" ? cardCount.value : null,
      lastCardCount: lastCardCount.status === "fulfilled" ? lastCardCount.value : null,
    }
  }

  /** 水晶手账 */
  async finance(uid, server) {
    const FINANCE_BASE = "https://api.mihoyo.com/bh3-weekly_finance/api"
    const make = (name, extra = "") =>
      `${FINANCE_BASE}/${name}?game_biz=bh3_cn&bind_uid=${uid}&bind_region=${server}${extra}`
    const urls = {
      index: make("index"),
      getLastMonthInfo: make("getLastMonthInfo"),
      getHcoinRecords: make("getHcoinRecords", "&page=1&limit=20"),
      getStarRecords: make("getStarRecords", "&page=1&limit=20"),
    }
    const headers = {
      "User-Agent": WEB_UA,
      Referer: "https://webstatic.mihoyo.com/",
      Cookie: this.cookie,
    }
    const entries = await Promise.all(
      Object.entries(urls).map(async ([name, url]) => {
        let res
        try {
          res = await fetchWithRetry(url, { headers }, { timeoutMs: 15000, retries: 1 })
        } catch (e) {
          throw new InfoError("网络请求失败，请稍后再试")
        }
        let data
        try {
          data = await res.json()
        } catch {
          throw new InfoError("手账接口异常，请稍后再试")
        }
        if (Number(data.retcode) !== 0) {
          throw new InfoError(`手账查询失败：${data.message || "请重新绑定Cookie"}`)
        }
        return [name, data.data]
      }),
    )
    const ret = Object.fromEntries(entries)

    // 补给卡数量(网页活动接口, 失败不影响主流程)
    const [cardCount, lastCardCount] = await Promise.all([
      this.handbookCount(uid, server, "current_month_count"),
      this.handbookCount(uid, server, "last_month_count"),
    ])
    ret.cardCount = cardCount
    ret.lastCardCount = lastCardCount
    return ret
  }

  /**
   * 通过cookie查询绑定的崩坏3角色列表
   * @returns {Promise<Array>}
   */
  static async getRoleListByCookie(cookie) {
    let res
    try {
      res = await fetch(BINDING_URL, {
        headers: { Cookie: cookie, "User-Agent": UA },
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw new InfoError("网络请求失败，请稍后再试")
    }
    let data
    try {
      data = await res.json()
    } catch {
      throw new InfoError("Cookie已失效，请重新绑定")
    }
    if (Number(data.retcode) !== 0) {
      throw new InfoError(`Cookie失效：${data.message || "请重新绑定"}`)
    }
    return (data.data?.list || []).filter(role => role.game_biz === "bh3_cn")
  }

  /** 通过cookie查询绑定的崩坏3角色(取等级最高) */
  static async getRoleByCookie(cookie) {
    const list = await Bh3.getRoleListByCookie(cookie)
    if (!list.length) return false
    list.sort((a, b) => b.level - a.level)
    return list[0]
  }

  /**
   * 通过米游社id查询崩坏3角色
   * @returns {Promise<{region, game_role_id, nickname}>}
   */
  static async mys2Role(cookie, mysuid) {
    const url = `${CARD_URL}?uid=${mysuid}`
    let res
    try {
      res = await fetch(url, {
        headers: {
          ...new Bh3(cookie).headers(`uid=${mysuid}`),
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw new InfoError("网络请求失败，请稍后再试")
    }
    const data = await res.json()
    if (Number(data.retcode) !== 0) {
      throw new InfoError(`查询失败：${data.message || "请稍后再试"}`)
    }
    const list = data.data?.list || []
    for (const game of list) {
      if (game.game_id === 1) {
        return {
          region: game.region,
          game_role_id: game.game_role_id,
          nickname: game.nickname,
        }
      }
    }
    throw new InfoError("该米游社账号没有崩坏3角色")
  }
}
