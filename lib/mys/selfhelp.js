import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { InfoError } from "./api.js"
import { APP_VERSION_AUTHKEY, DEVICE_ID, SALT_WEB_AUTHKEY, UA_SELFHELP } from "../apiConfig.js"
import { fetchWithRetry } from "../http.js"

const GEN_AUTHKEY_URL = "https://api-takumi.mihoyo.com/binding/api/genAuthKey"
const BASE = "https://public-operation-common.mihoyo.com/common/bh3_self_help_query"

const md5 = s => crypto.createHash("md5").update(s).digest("hex")

/** 生成网页 DS(web): md5(salt&t&r)，r 固定 6 位，避免随机串过短被风控 */
function dsWeb() {
  const t = Math.floor(Date.now() / 1000)
  const r = (Math.random().toString(36).slice(2) + "000000").slice(0, 6)
  return `${t},${r},${md5(`salt=${SALT_WEB_AUTHKEY}&t=${t}&r=${r}`)}`
}

/** 读取逍遥插件保存的 stoken（按 ltuid 匹配） */
export function getStokenByLtuid(ltuid) {
  if (!ltuid) return false
  try {
    const dir = path.join(process.cwd(), "plugins", "xiaoyao-cvs-plugin", "data", "yaml")
    if (!fs.existsSync(dir)) return false
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".yaml")) continue
      const text = fs.readFileSync(path.join(dir, file), "utf8")
      let cur = null
      const rows = []
      for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim()) continue
        if (!/^\s/.test(raw)) {
          const m = raw.match(/^"?([^":]+)"?:\s*$/)
          if (m) {
            cur = { uid: m[1] }
            rows.push(cur)
          }
          continue
        }
        const m = raw.match(/^\s+([\w]+):\s*(.*)$/)
        if (m && cur) {
          let v = m[2].trim()
          if (/^".*"$/.test(v)) v = v.slice(1, -1)
          cur[m[1]] = v
        }
      }
      for (const r of rows) {
        if (String(r.stuid) === String(ltuid) && r.stoken) {
          return { stuid: r.stuid, stoken: r.stoken, mid: r.mid, ltoken: r.ltoken }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

/** 用 stoken 换取自助查询用的 authkey（auth_appid=im_ccs） */
export async function genAuthKey(uid, region, stoken) {
  if (!stoken || !stoken.stoken) {
    throw new InfoError("未找到 stoken，无法查询记录。请先在逍遥插件绑定 stoken，或发送【#绑定Cookie】")
  }
  const cookie = `stuid=${stoken.stuid};stoken=${stoken.stoken};mid=${stoken.mid || ""};`
  const body = JSON.stringify({
    auth_appid: "im_ccs",
    game_biz: "bh3_cn",
    game_uid: Number(uid),
    region,
  })
  let res
  try {
    res = await fetchWithRetry(GEN_AUTHKEY_URL, {
      method: "POST",
      headers: {
        "x-rpc-app_version": APP_VERSION_AUTHKEY,
        "User-Agent": "okhttp/4.9.3",
        "x-rpc-client_type": "2",
        Referer: "https://act.mihoyo.com/",
        Origin: "https://act.mihoyo.com",
        "x-rpc-sys_version": "12",
        "x-rpc-channel": "miyousheluodi",
        "x-rpc-device_id": DEVICE_ID,
        "x-rpc-device_name": "XQ-BC52",
        "x-rpc-device_model": "Sony XQ-BC52",
        "Content-Type": "application/json",
        "x-rpc-combo_token": "",
        Cookie: cookie,
        DS: dsWeb(),
        Host: "api-takumi.mihoyo.com",
      },
      body,
    }, { timeoutMs: 15000, retries: 1 })
  } catch {
    throw new InfoError("网络请求失败，请稍后再试")
  }
  let data
  try {
    data = await res.json()
  } catch {
    throw new InfoError("获取查询凭据失败，请重新绑定 Cookie")
  }
  if (Number(data.retcode) !== 0 || !data.data?.authkey) {
    throw new InfoError(`获取查询凭据失败：${data.message || "请重新绑定 Cookie"}`)
  }
  return data.data.authkey
}

/** 自助查询接口封装 */
export class SelfHelp {
  /**
   * @param authkey 由 genAuthKey 生成
   * @param uid 崩坏3游戏uid
   */
  constructor(authkey, uid) {
    this.authkey = authkey
    this.uid = String(uid)
  }

  url(api, extra = {}) {
    const params = new URLSearchParams({
      sign_type: "2",
      auth_appid: "im_ccs",
      authkey_ver: "1",
      app_client: "bbs",
      game_biz: "bh3_cn",
      bbs_game_role_required: "bh3_cn",
      lang: "zh-cn",
      authkey: this.authkey,
      community_select_uid: this.uid,
      ...extra,
    })
    return `${BASE}/${api}?${params.toString()}`
  }

  async req(api, extra = {}) {
    let res
    try {
      res = await fetchWithRetry(this.url(api, extra), {
        headers: {
          "User-Agent": UA_SELFHELP,
          Referer: "https://webstatic.mihoyo.com/",
        },
      }, { timeoutMs: 20000, retries: 1 })
    } catch {
      throw new InfoError("网络请求失败，请稍后再试")
    }
    let data
    try {
      data = await res.json()
    } catch {
      throw new InfoError("自助查询接口异常，请稍后再试")
    }
    if (Number(data.retcode) !== 0) {
      if (Number(data.retcode) === -100 || /login/i.test(data.message || "")) {
        throw new InfoError("查询凭据失效，请重新绑定 Cookie")
      }
      throw new InfoError(`自助查询失败：${data.message || data.retcode}`)
    }
    return data.data
  }

  /** 角色信息 */
  userInfo() {
    return this.req("UserInfoQuery/GetUserInfo")
  }

  /**
   * 记录分类（补给/道具的子类型）
   * @param type 1=补给 2=水晶 3=充值 4=道具 5=登录
   */
  menus(type) {
    return this.req("UserMenuQuery/GetMenus", { type })
  }

  /** 补给记录 */
  gacha(type, page = 1, size = 10) {
    return this.req("UserGachaQuery/GetUserGacha", { type, page, size })
  }

  /** 道具记录 */
  material(type, page = 1, size = 10) {
    return this.req("UserMaterialQuery/GetUserMaterial", { type, page, size })
  }

  /** 水晶记录 */
  hcoin(type, page = 1, size = 10) {
    return this.req("UserMaterialQuery/GetUserHCoin", { type, page, size })
  }
}
