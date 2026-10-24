import lodash from "lodash"
import { Bh3, InfoError, loadRegion } from "./api.js"

/**
 * 从yunzai的cookie系统中获取用户绑定的cookie与崩坏3uid
 * (由genshin插件/NoteUser管理,无需手动填写config)
 */
export class CookieMgr {
  /** 获取用户绑定的全部cookie(ck字符串列表) */
  static getCkList(user) {
    if (!user || lodash.isEmpty(user.mysUsers)) return []
    const cks = []
    for (const ltuid in user.mysUsers) {
      const mys = user.mysUsers[ltuid]
      if (mys && mys.ck) cks.push(mys.ck)
    }
    return cks
  }

  /** 获取用户第一个可用cookie */
  static getFirstCk(user) {
    const cks = CookieMgr.getCkList(user)
    if (!cks.length) return false
    return cks[0]
  }

  /** yunzai已登记的崩坏3uid列表(主uid在前) */
  static getBh3Uids(user) {
    if (!user) return []
    try {
      const main = String(user.getCkUid("bh3") || "")
      const list = user.getCkUidList("bh3").map(ds => String(ds.uid))
      if (main && list[0] !== main) {
        list.unshift(main)
      }
      return [...new Set(list)]
    } catch {
      return []
    }
  }

  /** uid对应的cookie(yunzai登记数据) */
  static getCkByUid(user, uid) {
    if (!user) return ""
    try {
      const uidData = user.getUidData(uid, "bh3")
      if (uidData?.ltuid) {
        const mys = user.mysUsers[uidData.ltuid]
        return mys?.ck || ""
      }
    } catch {}
    return ""
  }

  /** uid -> 服务器 缓存(redis) */
  static async cacheRegion(uid, server) {
    try {
      await redis.set(`honkai:mys:region:${uid}`, server, { EX: 7 * 86400 })
    } catch {}
  }

  static async getCachedRegion(uid) {
    try {
      return (await redis.get(`honkai:mys:region:${uid}`)) || ""
    } catch {
      return ""
    }
  }

  /** 获取用户自己的崩坏3角色(优先使用yunzai已登记的uid) */
  static async getSelfBh3Role(user) {
    const cks = CookieMgr.getCkList(user)
    if (!cks.length) {
      throw new InfoError("请先绑定Cookie，发送【#绑定Cookie】或【Cookie帮助】获取教程")
    }

    // 优先使用yunzai登记过的崩坏3uid
    for (const uid of CookieMgr.getBh3Uids(user)) {
      const ck = CookieMgr.getCkByUid(user, uid)
      if (!ck) continue
      let server = await CookieMgr.getCachedRegion(uid)
      if (!server) {
        try {
          const roles = await Bh3.getRoleListByCookie(ck)
          const role = roles.find(r => r.game_uid === uid)
          if (!role) continue
          server = role.region
          await CookieMgr.cacheRegion(uid, server)
        } catch {
          continue
        }
      }
      return { cookie: ck, uid, server }
    }

    // 老绑定未登记bh3 → 遍历cookie直接查询
    let lastErr = "该账号未绑定崩坏3角色"
    for (const ck of cks) {
      try {
        const role = await Bh3.getRoleByCookie(ck)
        if (role) {
          await CookieMgr.cacheRegion(role.game_uid, role.region)
          return { cookie: ck, uid: role.game_uid, server: role.region }
        }
      } catch (err) {
        lastErr = err.message
      }
    }
    throw new InfoError(lastErr)
  }

  /**
   * 自动识别指定 uid 所属的服务器与可用 Cookie
   * 依次尝试: 缓存 -> 已登记该 uid 的 Cookie -> 遍历用户所有 Cookie -> 逐渠道探测
   * @returns {Promise<{cookie:string, server:string}|null>}
   */
  static async findRoleByUid(user, uid) {
    uid = String(uid)
    // 优先读取缓存的服务器
    const cached = await CookieMgr.getCachedRegion(uid)
    // yunzai已登记的uid → 直接拿对应cookie查询
    const ck = CookieMgr.getCkByUid(user, uid)
    if (ck) {
      if (cached) return { cookie: ck, server: cached }
      try {
        const roles = await Bh3.getRoleListByCookie(ck)
        const role = roles.find(r => String(r.game_uid) === uid)
        if (role) {
          await CookieMgr.cacheRegion(uid, role.region)
          return { cookie: ck, server: role.region }
        }
      } catch {}
    }
    // 遍历所有cookie
    for (const item of CookieMgr.getCkList(user)) {
      try {
        const roles = await Bh3.getRoleListByCookie(item)
        const role = roles.find(r => String(r.game_uid) === uid)
        if (role) {
          await CookieMgr.cacheRegion(uid, role.region)
          return { cookie: item, server: role.region }
        }
      } catch {}
    }
    // 回退: 用已缓存的服务器 + 第一个cookie
    if (cached) {
      const fallbackCk = ck || CookieMgr.getFirstCk(user)
      if (fallbackCk) return { cookie: fallbackCk, server: cached }
    }
    // 最后: 用第一个cookie逐渠道探测
    const probeCk = ck || CookieMgr.getFirstCk(user)
    if (probeCk) {
      const server = await CookieMgr.probeServer(probeCk, uid)
      if (server) {
        await CookieMgr.cacheRegion(uid, server)
        return { cookie: probeCk, server }
      }
    }
    return null
  }

  /** 逐渠道探测 uid 所属服务器(崩坏3各渠道共 7 个) */
  static async probeServer(cookie, uid) {
    const regions = loadRegion()
    for (const key of Object.keys(regions)) {
      try {
        await new Bh3(cookie).index(uid, key)
        return key
      } catch {
        // 该渠道不匹配，继续尝试下一个
      }
    }
    return false
  }

  /** 在用户所有cookie中查找指定uid的所属服务器 */
  static async findUidServer(user, uid) {
    const found = await CookieMgr.findRoleByUid(user, uid)
    return found ? found.server : false
  }
}
