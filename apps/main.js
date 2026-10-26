import {
  getUserGameRoles,
  recordRequest,
} from '../lib/api.js'
import {
  formatWikiDetail,
  wikiDetail,
  wikiSearch,
} from '../lib/wiki.js'
import {
  findCharacter,
  getAllCharacters,
  searchCharacters,
} from '../lib/characters.js'
import { readCharacterMeta, updateCharacterData } from '../lib/characterUpdater.js'
import { calculateDamage } from '../lib/damage.js'
import { renderHelpImage } from '../lib/helpImage.js'
import { renderCardImage } from '../lib/cardImage.js'
import {
  getBindUid,
  getCookie,
  getExternalCk,
  removeBindUid,
  setBindUid,
  setCookie,
} from '../lib/store.js'
import { CookieMgr } from '../lib/mys/cookie.js'
import { Bh3, InfoError, id2server, server2id } from '../lib/mys/api.js'
import {
  buildAbyssBoard,
  buildAbyssCard as buildMysAbyssCard,
  buildBattleCard as buildMysBattleCard,
  buildBattleFieldBoard,
  buildCharaCard as buildMysCharaCard,
  buildFinanceCard,
  buildGachaCard,
  buildGodWarBoard,
  buildIndexCard,
  buildNoteCard,
  buildRecordCard,
  buildReportCard,
  buildWeeklyCard,
  extractReportHistory,
} from '../lib/mys/card.js'
import { getReports, saveReports } from '../lib/mys/store.js'
import { SelfHelp, genAuthKey, getStokenByLtuid } from '../lib/mys/selfhelp.js'
import { collectRecords, updateRecords } from '../lib/mys/record.js'
import { renderMysTemplate, DEVICE_SCALE } from '../lib/mys/render.js'

const PREFIX = '#?(崩坏3|崩三|bbb|bh3)'

/** 从消息中剥离前缀与关键词，保留剩余参数(用于 honkai-mys 移植指令) */
function stripMysKeyword(msg = '', keyword = '') {
  return String(msg)
    .replace(new RegExp(`^${PREFIX}`), '')
    .replace(new RegExp(`^${keyword}`), '')
    .trim()
}

const ATTRIBUTE_MAP = {
  1: '生物',
  2: '异能',
  3: '机械',
  4: '量子',
  5: '虚数',
  6: '星尘',
}

function battleAreaLabel(area = 0) {
  const map = { 1: '低级区', 2: '中级区', 3: '高级区' }
  return map[Number(area)] || `${area}区`
}

function avatarItem(avatar = {}, extra = {}) {
  const img = avatar.icon_path
    || avatar.background_path
    || avatar.sec_part_icon
    || avatar.avatar
    || ''
  const attribute = ATTRIBUTE_MAP[Number(avatar.attribute_id)] || ''
  const tagParts = []
  if (extra.label) tagParts.push(extra.label)
  if (avatar.star) tagParts.push(`★${avatar.star}`)
  if (extra.level) tagParts.push(`Lv.${extra.level}`)
  if (attribute) tagParts.push(attribute)
  return { name: avatar.name || '未知', img, tag: tagParts.filter(Boolean).join(' ') }
}

function buildCharactersCard(data = {}) {
  const list = Array.isArray(data.characters) ? data.characters : []
  if (list.length === 0) {
    return { text: '该账号暂无角色数据。', avatarGroups: [] }
  }
  const showCount = Math.min(list.length, 30)
  const text = list.length > showCount ? `共 ${list.length} 名角色，显示前 ${showCount} 名` : `共 ${list.length} 名角色`
  return {
    text,
    avatarGroups: [{
      title: '角色列表',
      items: list.slice(0, showCount).map(item => avatarItem(item.character?.avatar || {})),
    }],
  }
}

const NEW_ABYSS_LEVEL = { 1: '禁忌', 2: '原罪I', 3: '原罪II', 4: '原罪III', 5: '苦痛I', 6: '苦痛II', 7: '苦痛III', 8: '红莲', 9: '寂灭' }
const OLD_ABYSS_LEVEL = { D: '禁忌', C: '原罪', B: '苦痛', A: '红莲', S: '寂灭' }
const GODWAR_LEVEL = { 303: '沦没', 304: '戒约', 305: '侵蚀', 306: '终尽' }

function buildAbyssCard(data = {}, title = '超弦空间') {
  const reports = Array.isArray(data.reports) ? data.reports : []
  if (reports.length === 0) {
    return { text: `暂无${title}记录。`, avatarGroups: [] }
  }
  const text = [`共 ${reports.length} 期记录`].join('\n')
  const avatarGroups = reports.map((report, index) => {
    const boss = report.boss || {}
    const lineup = Array.isArray(report.lineup) ? report.lineup : []
    const items = lineup.map(character => avatarItem(character))
    if (report.elf?.avatar) {
      items.push(avatarItem({ name: report.elf.name || '人偶', avatar: report.elf.avatar, star: report.elf.star }))
    }
    const levelLabel = report.isOldData
      ? OLD_ABYSS_LEVEL[report.level] || '未知段位'
      : NEW_ABYSS_LEVEL[report.level] || '未知段位'
    return {
      title: `第${index + 1}期 · ${boss.name || 'BOSS'} · ${report.score ?? 0}分 · ${levelLabel}`,
      items,
    }
  })
  return { text, avatarGroups }
}

function buildBattleFieldCard(data = {}) {
  const reports = Array.isArray(data.reports) ? data.reports : []
  if (reports.length === 0) {
    return { text: '暂无记忆战场记录。', avatarGroups: [] }
  }
  const text = reports.map((report, index) =>
    `第${index + 1}期：排名 ${report.rank ?? '?'} · 前${report.ranking_percentage ?? '?'}% · ${battleAreaLabel(report.area)}`
  ).join('\n')
  const avatarGroups = reports.map((report, index) => {
    const info = report.battle_infos?.[0] || {}
    const lineup = Array.isArray(info.lineup) ? info.lineup : []
    const items = lineup.map(character => avatarItem(character))
    if (info.elf?.avatar) {
      items.push(avatarItem({ name: info.elf.name || '人偶', avatar: info.elf.avatar, star: info.elf.star }))
    }
    return {
      title: `第${index + 1}期队伍 · ${report.score ?? 0}分`,
      items,
    }
  })
  return { text, avatarGroups }
}

function buildGodWarCard(data = {}) {
  const summary = data.summary || {}
  const stats = [
    { label: '解锁装甲', value: summary.avatar_numbers ?? 0 },
    { label: '命定歧路', value: summary.max_support_point ?? 0 },
    { label: '追忆之证', value: summary.extra_item_number ?? 0 },
    { label: '满强化装甲', value: summary.max_level_avatar_number ?? 0 },
    { label: '最高挑战', value: summary.max_challenge_score ?? 0 },
  ]
  const avatarGroups = []
  const transcript = Array.isArray(data.avatar_transcript) ? data.avatar_transcript : []
  if (transcript.length > 0) {
    avatarGroups.push({
      title: '装甲成绩单',
      items: transcript.map(item => avatarItem(item.avatar || {}, { level: item.level })),
    })
  }
  const records = Array.isArray(data.records) ? data.records : []
  records.forEach((record, index) => {
    const main = record.main_avatar || {}
    const supports = Array.isArray(record.support_avatars) ? record.support_avatars : []
    const items = []
    if (main.icon_path || main.background_path || main.sec_part_icon) {
      items.push(avatarItem(main, { label: '出战' }))
    }
    for (const support of supports) {
      if (support.icon_path || support.background_path || support.sec_part_icon) {
        items.push(avatarItem(support, { label: '支援' }))
      }
    }
    if (record.elf?.avatar) {
      items.push(avatarItem({ name: record.elf.name || '人偶', avatar: record.elf.avatar, star: record.elf.star }, { label: '人偶' }))
    }
    const difficulty = GODWAR_LEVEL[record.punish_level] || `难度${record.punish_level ?? '?'}`
    if (items.length > 0) {
      avatarGroups.push({
        title: `第${index + 1}次挑战 · ${difficulty} · ${record.score ?? 0}分`,
        items,
      })
    }
  })
  const text = records.length > 0 ? `共 ${records.length} 次挑战记录` : '暂无挑战记录'
  return { text, stats, avatarGroups }
}

function buildHelp() {
  const characterCount = getAllCharacters().length
  const listLabel = characterCount > 0 ? `${characterCount} 名女武神清单` : '女武神清单'
  const dbLabel = characterCount > 0 ? `内置 ${characterCount} 名女武神数据库` : '内置女武神数据库'
  return [
    '=== 崩坏3 查询插件 ===',
    '',
    '【战绩查询】（主人配置一次公共 Cookie，群友只凭 UID 即可查询）',
    '#崩坏3cookie <完整Cookie>　　主人配置公共 Cookie（仅限私聊）',
    '#崩坏3cookie <UID> <Cookie>　为指定 UID 配置专用 Cookie（仅限私聊）',
    '#崩坏3绑定 / #崩坏3绑定 <UID>　按 Cookie 账号自动绑定 / 手动指定 UID',
    '#崩坏3切换 <UID>　　　　　　切换查询 UID',
    '#崩坏3当前　　　　　　　　　查看当前 UID',
    '#崩坏3解绑　　　　　　　　　解除绑定',
    '（已 #绑定Cookie 时可不绑定 UID，直接查询将自动使用 Cookie 账号）',
    '',
    '#崩坏3面板　　总览卡片（与玩家卡片同模板）',
    '#崩坏3体力 / #崩坏3便笺　实时便签卡片（体力/训练/深渊/战场/乐土）',
    '#崩坏3角色　　　　　　　拥有的女武神列表（Cookie 账号）',
    '#崩坏3角色 <角色名>　　　角色面板（大头像/装备/六维）',
    `#崩坏3角色列表　　　　　${listLabel}`,
    '#崩坏3深渊　　超弦空间战绩',
    '#崩坏3战场　　记忆战场战绩',
    '#崩坏3逐光　　往世乐土战绩',
    '（以上命令默认查询绑定的 UID，也可临时加 UID：如 #崩坏3面板 100000001）',
    '',
    '【玩家卡片 / 战报 / 手账】（触发头亦可用 #bh3）',
    '#崩坏3 [uid]　　　　　　玩家卡片（服务器可省略，自动识别）',
    '#崩坏3战报　　　　　　　舰长战报（成绩单/深渊/战场）',
    '#崩坏3深渊战报 / #崩坏3战场战报　更多近期战报（含本地历史）',
    '#崩坏3一周成绩单　　　　一周成绩单（含本地历史）',
    '#崩坏3手帐　　　　　　　水晶手账（需绑定 Cookie）',
    '',
    '【补给 / 道具记录】（米游社自助查询，需逍遥插件 stoken）',
    '#崩坏3更新抽卡记录 / #崩坏3刷新补给记录　更新并保存补给记录',
    '#崩坏3抽卡记录 [角色|装备|家园]　　查看补给记录',
    '#崩坏3抽卡统计　　　　　抽卡统计（S 级/5 星）',
    '#崩坏3更新道具记录 / #崩坏3道具记录　更新并查看道具记录',
    '',
    `【角色数据】（${dbLabel}，支持别名）`,
    '#崩坏3角色图 <名字/别名>　　角色立绘 + 背景图 + 角色档案',
    '#崩坏3角色 <角色名>　　　　角色面板（大头像/装备/六维，仿喵喵风格）',
    '#崩坏3伤害 <角色> [攻击]　 伤害估算（攻击省略时自动用图鉴基础攻击）',
    '  参数：攻击 倍率% 增伤% 暴击率% 暴击伤害% 防御 抗性%，例：#崩坏3伤害 炎律 300 20 100 200',
    '#崩坏3更新角色库　　　　　主人手动刷新女武神数据库',
    '',
    '【图鉴查询】（公开数据，无需 Cookie）',
    '#崩坏3图鉴 <关键词>　　　　搜索图鉴',
    '#崩坏3角色图鉴 <名字>　　　角色图鉴',
    '#崩坏3武器图鉴 <名字>　　　武器图鉴',
    '#崩坏3圣痕图鉴 <名字>　　　圣痕图鉴',
    '#崩坏3图鉴详情 <编号>　　　查看指定条目',
    '',
    '提示：以上命令前缀也可使用「崩三」或「bbb」。',
  ].join('\n')
}

function isMaster(e = {}) {
  return e?.isMaster === true
}

/** UID 脱敏：保留前 3 位与后 2 位，避免群聊/日志出现完整账号 */
function maskUid(uid = '') {
  const text = String(uid || '')
  if (text.length <= 5) return text || '默认'
  return `${text.slice(0, 3)}****${text.slice(-2)}`
}

/** 回复渲染结果；渲染彻底失败时回退文字，避免把 null 塞进消息段 */
function replyMysCard(e, img) {
  if (!img) {
    return e.reply('制图失败，请稍后再试。')
  }
  return e.reply([img])
}

export class Bh3Plugin extends plugin {
  constructor() {
    super({
      name: 'bh3-plugin',
      dsc: '崩坏3全功能查询',
      event: 'message',
      priority: -2000,
      rule: [
        { reg: `^${PREFIX}(帮助|菜单|使用)$`, fnc: 'help' },
        { reg: `^${PREFIX}帮助文本$`, fnc: 'helpText' },
        { reg: `^${PREFIX}绑定\\s*$`, fnc: 'bindCurrent' },
        { reg: `^${PREFIX}绑定\\s+(\\d{5,12})$`, fnc: 'bindUid' },
        { reg: `^${PREFIX}(切换|切换uid|切换UID)\\s+(\\d{5,12})$`, fnc: 'switchUid' },
        { reg: `^${PREFIX}(当前|当前uid|当前UID|我的uid|查看uid)\\s*$`, fnc: 'showCurrentUid' },
        { reg: `^${PREFIX}解绑\\s*$`, fnc: 'unbindUid' },
        { reg: `^${PREFIX}cookie(\\s+(\\d{5,12}))?(\\s+[\\s\\S]+)?$`, fnc: 'setCookie', log: false },
        { reg: `^${PREFIX}(伤害|伤害计算)\\s+([\\s\\S]+)$`, fnc: 'damageCommand' },
        { reg: `^${PREFIX}(角色图|立绘|背景图|图鉴卡)\\s+([\\s\\S]+)$`, fnc: 'characterArtCommand' },
        { reg: `^${PREFIX}角色列表(?:\\s+(\\d{5,12}))?$`, fnc: 'showCharacters' },
        { reg: `^${PREFIX}(更新|刷新)角色库$`, fnc: 'refreshCharacters' },
        { reg: `^${PREFIX}图鉴详情\\s+(\\d+)\\s*$`, fnc: 'wikiDetailCommand' },
        { reg: `^${PREFIX}(角色图鉴|武器图鉴|圣痕图鉴|人偶图鉴|协同者图鉴)\\s+([\\s\\S]+)$`, fnc: 'wikiSearchByType' },
        { reg: `^${PREFIX}(图鉴|查询|wiki)\\s+([\\s\\S]+)$`, fnc: 'wikiSearchCommand' },
        { reg: `^${PREFIX}(面板|总览|我的|主页)(\\s+(\\d{5,12}))?$`, fnc: 'showIndex' },
        // ===== honkai-mys 移植指令(需在校验最宽泛的 #崩坏3 之前) =====
        { reg: `^${PREFIX}(体力|便签|便笺|实时便签|实时便笺)(?=$|@|[\\s\\d])`, fnc: 'mysNote', log: false },
        { reg: `^${PREFIX}角色(?=$|@|(?:\\s+\\d{6,10})\\s*$)`, fnc: 'mysChara', log: false },
        { reg: `^${PREFIX}(深渊战报|战场战报)(?=$|[\\s\\d])`, fnc: 'mysBranchReport', log: false },
        { reg: `^${PREFIX}(一周成绩单|成绩单)(?=$|[\\s\\d])`, fnc: 'mysWeekly', log: false },
        { reg: `^${PREFIX}(舰长战报|战报)(?=$|[\\s\\d])`, fnc: 'mysReport', log: false },
        { reg: `^${PREFIX}(手帐|手账)(?=$|[\\s\\d])`, fnc: 'mysFinance', log: false },
        { reg: `^${PREFIX}(更新|刷新)(抽卡|补给)记录`, fnc: 'mysUpdateGacha', log: false },
        { reg: `^${PREFIX}(更新|刷新)道具记录`, fnc: 'mysUpdateMaterial', log: false },
        { reg: `^${PREFIX}(抽卡记录|补给记录)`, fnc: 'mysGacha', log: false },
        { reg: `^${PREFIX}(抽卡|补给)统计`, fnc: 'mysGachaStat', log: false },
        { reg: `^${PREFIX}道具记录`, fnc: 'mysMaterial', log: false },
        // ===== 原有宽泛指令 =====
        { reg: `^${PREFIX}角色(\\s+(\\d{5,12}))?(\\s+([\\s\\S]+))?$`, fnc: 'showCharacters' },
        { reg: `^${PREFIX}(深渊|超弦)(\\s+(\\d{5,12}))?$`, fnc: 'showAbyss' },
        { reg: `^${PREFIX}(战场|记忆战场)(\\s+(\\d{5,12}))?$`, fnc: 'showBattleField' },
        { reg: `^${PREFIX}(逐光)(\\s+(\\d{5,12}))?$`, fnc: 'showGodWar' },
        // 校验最宽泛的 #崩坏3 / #bh3(玩家卡片)，必须放在最后
        { reg: `^${PREFIX}(?=$|[\\s\\d]|[mM][yY][sS]|米游社)`, fnc: 'mysCard', log: false },
      ],
    })
  }

  async help(e) {
    const imagePath = await renderHelpImage()
    if (imagePath && globalThis.segment?.image) {
      return e.reply(globalThis.segment.image(imagePath))
    }
    return e.reply(buildHelp())
  }

  async helpText(e) {
    return e.reply(buildHelp())
  }

  async replyWithCard(e, options = {}) {
    const imagePath = await renderCardImage(options)
    const seg = globalThis.segment
    const messages = []
    if (imagePath && seg?.image) {
      messages.push(seg.image(imagePath))
    }
    const links = (Array.isArray(options.links) ? options.links : []).filter(Boolean)
    if (links.length > 0) {
      messages.push(`链接：\n${links.join('\n')}`)
    }
    if (messages.length > 0) {
      return e.reply(messages)
    }
    return e.reply(options.text || '查询结果为空。')
  }

  async bindUid(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}绑定\\s+(\\d{5,12})$`))
    const uid = match?.[2] || match?.[1] || ''
    if (!uid) {
      return e.reply('请使用：#崩坏3绑定 <游戏UID>')
    }
    setBindUid(e.user_id, uid)
    return e.reply(`已绑定崩坏3 UID：${uid}（可通过 #崩坏3面板 查询）`)
  }

  /** #崩坏3绑定(不带 UID): 使用米游社 Cookie 账号自动绑定(honkai-mys 绑定方式) */
  async bindCurrent(e) {
    const auto = await this.resolveCookieRole(e)
    if (!auto?.uid) {
      return e.reply('未在绑定的 Cookie 中找到崩坏3角色。\n请先发送 #绑定Cookie 登录米游社账号，再发送 #崩坏3绑定；或使用 #崩坏3绑定 <UID> 手动绑定。')
    }
    setBindUid(e.user_id, auto.uid)
    const server = auto.server ? `（服务器 ${auto.server}）` : ''
    return e.reply(`已根据米游社 Cookie 账号自动绑定崩坏3 UID：${auto.uid}${server}\n之后可直接发送 #崩坏3面板 查询。`)
  }

  async unbindUid(e) {
    removeBindUid(e.user_id)
    return e.reply('已解除崩坏3 UID 绑定。')
  }

  async switchUid(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(切换|切换uid|切换UID)\\s+(\\d{5,12})$`))
    const uid = match?.[3] || ''
    if (!uid) {
      return e.reply('用法：#崩坏3切换 <UID>')
    }
    setBindUid(e.user_id, uid)
    return e.reply(`已将当前查询 UID 切换为：${uid}（发送 #崩坏3当前 可查看）`)
  }

  async showCurrentUid(e) {
    const uid = getBindUid(e.user_id)
    if (uid) {
      return e.reply(`当前绑定的崩坏3 UID：${uid}（发送 #崩坏3切换 <新UID> 可切换）`)
    }
    // 未手动绑定: 尝试使用米游社 Cookie 账号(与 honkai-mys 一致)
    const auto = await this.resolveCookieRole(e)
    if (auto?.uid) {
      return e.reply(`当前未手动绑定 UID，查询将自动使用 Cookie 账号：${auto.uid}（发送 #崩坏3绑定 <UID> 可手动指定）`)
    }
    return e.reply('尚未绑定 UID。发送 #崩坏3绑定 <UID> 绑定，或先通过 #绑定Cookie 登录米游社账号后再查询。')
  }

  async setCookie(e) {
    if (!isMaster(e)) {
      return e.reply('仅 Bot 主人可以配置 Cookie。')
    }
    // Cookie 等同账号凭据：群聊中的消息可能被平台留存或他人翻看，改为私聊提交
    if (e.isGroup) {
      return e.reply('为保护账号安全，请在与 Bot 的私聊中发送 #崩坏3cookie <完整Cookie>，不要在群里发送。')
    }
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}cookie(\\s+(\\d{5,12}))?(\\s+[\\s\\S]+)?$`))
    const uid = match?.[3] || ''
    const cookie = String(match?.[4] || '').trim()
    if (!cookie) {
      return e.reply('用法：#崩坏3cookie [UID] <米游社完整Cookie>')
    }
    try {
      const roles = await getUserGameRoles(cookie)
      if (roles.length === 0) {
        return e.reply('Cookie 有效，但未找到崩坏3 角色，请确认账号已开通崩坏3 战绩。')
      }
      setCookie(uid, cookie)
      // 不回显昵称与完整 game_uid，避免群聊/日志泄露账号信息
      return e.reply(`Cookie 已保存${uid ? `（UID ${maskUid(uid)}）` : '（默认）'}，检测到 ${roles.length} 个崩坏3角色。`)
    } catch (error) {
      return e.reply(`Cookie 校验失败：${error.message}`)
    }
  }

  /**
   * 通过米游社 Cookie 账号解析崩坏3角色(与 honkai-mys 的绑定方式一致)
   * 使用 yunzai 已绑定的 Cookie(#绑定Cookie)，无需手动 #崩坏3绑定
   * @returns {Promise<{uid:string,cookie:string,server:string}|null>}
   */
  async resolveCookieRole(e = {}) {
    try {
      const role = await CookieMgr.getSelfBh3Role(e.user)
      if (role?.uid && role?.cookie) {
        return { uid: String(role.uid), cookie: role.cookie, server: role.server }
      }
    } catch (error) {
      if (globalThis.logger?.debug) {
        globalThis.logger.debug(`[bh3] Cookie 账号自动解析失败: ${error.message}`)
      }
    }
    return null
  }

  /**
   * 解析要查询的 UID 与 Cookie
   * 顺序: 显式 UID > 手动绑定 UID > 米游社 Cookie 账号(honkai-mys 绑定方式)
   * @returns {Promise<{uid:string,cookie:string}>}
   */
  async resolveUid(e, explicitUid = '') {
    // 显式 UID 可能来自正则的「带空格」捕获组，这里统一去掉空白
    const uid = String(explicitUid || '').trim() || getBindUid(e.user_id)
    if (uid) {
      // 共享库(MysUsers)里的 ck 属于其他用户，仅主人可代为读取，避免越权查询他人账号
      const externalCk = isMaster(e) ? await getExternalCk(uid) : ''
      const cookie = getCookie(uid)
        || getCookie('')
        || externalCk
        || this.getCookieFromUser(e, uid)
      return { uid: String(uid), cookie }
    }
    const auto = await this.resolveCookieRole(e)
    return auto ? { uid: auto.uid, cookie: auto.cookie } : { uid: '', cookie: '' }
  }

  /** 从 yunzai 已绑定的 Cookie 中获取指定 UID 的 CK */
  getCookieFromUser(e = {}, uid = '') {
    try {
      return CookieMgr.getCkByUid(e.user, uid) || ''
    } catch {
      return ''
    }
  }

  async withUid(e, action, explicitUid = '') {
    const { uid, cookie } = await this.resolveUid(e, explicitUid)
    if (!uid) {
      return e.reply('请提供 UID、使用 #崩坏3绑定 <UID> 绑定，或先通过 #绑定Cookie 登录米游社账号。')
    }
    if (!cookie) {
      return e.reply(`无法查询 UID ${uid}：崩坏3战绩接口仅支持查询账号本人的号。\n请先通过 #绑定Cookie 登录该 UID 对应的米游社账号，或让主人执行 #崩坏3cookie ${uid} <完整Cookie> 为该 UID 配置。`)
    }
    try {
      return await action(uid, cookie)
    } catch (error) {
      return e.reply(`查询失败：${error.message}`)
    }
  }

  async showIndex(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(面板|总览|我的|主页)(\\s+(\\d{5,12}))?$`))
    return this.withUid(e, async (uid, cookie) => {
      const index = await recordRequest('/index', uid, {}, cookie)
      // 与 #崩坏3 玩家卡片共用 bh3card 模板，顺带补齐战报数据；单项失败不影响主卡片
      const [weekly, newAbyss, oldAbyss, battle] = await Promise.allSettled([
        recordRequest('/weeklyReport', uid, {}, cookie),
        recordRequest('/newAbyssReport', uid, {}, cookie),
        recordRequest('/latestOldAbyssReport', uid, {}, cookie),
        recordRequest('/battleFieldReport', uid, {}, cookie),
      ])
      const pick = result => (result.status === 'fulfilled' ? result.value : null)
      const raw = {
        index,
        weeklyReport: pick(weekly),
        newAbyssReport: pick(newAbyss),
        latestOldAbyssReport: pick(oldAbyss),
        battleFieldReport: pick(battle),
      }
      const img = await this.renderMysHtml(
        'html/bh3card',
        buildIndexCard(raw, { uid, server: index.role?.region || '' }),
      )
      return replyMysCard(e, img)
    }, String(match?.[4] || '').trim())
  }

  /** #崩坏3更新角色库：主人手动刷新女武神数据库（启动时也会自动检查更新） */
  async refreshCharacters(e) {
    if (!isMaster(e)) {
      return e.reply('仅主人可以更新角色数据库。')
    }
    const meta = readCharacterMeta()
    await e.reply(`开始从米游社图鉴更新角色数据库（当前 ${meta.count} 名）…\n抓取约需半分钟，完成后自动生效，无需重启。`)
    const result = await updateCharacterData()
    if (!result.ok) {
      return e.reply(`角色数据库更新失败：${result.reason || '未知原因'}\n原有数据已保留。`)
    }
    return e.reply(`角色数据库已更新：${result.count} 名女武神（抓取失败 ${result.failed} 个），已立即生效。`)
  }

  async showCharacters(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}角色(?:列表)?(\\s+(\\d{5,12}))?(\\s+([\\s\\S]+))?$`))
    const uid = match?.[3] || ''
    const keyword = String(match?.[5] || '').trim()
    if (!uid && !keyword) {
      const list = getAllCharacters()
      const lines = [`=== 崩坏3 女武神数据库（${list.length}） ===`]
      lines.push(list.map(character => character.name).join('、'))
      return this.replyWithCard(e, {
        title: '崩坏3 女武神数据库',
        subtitle: `共 ${list.length} 名角色`,
        text: lines.join('\n'),
      })
    }
    if (!uid && keyword) {
      const archive = this.characterArchiveReply(keyword)
      if (typeof archive === 'string') {
        return e.reply(archive)
      }
      return e.reply(archive)
    }
    return this.withUid(e, async (uidValue, cookie) => {
      const data = await recordRequest('/characters', uidValue, {}, cookie)
      if (keyword) {
        const panel = this.formatSingleCharacter(data, keyword, uidValue)
        return this.replyWithCard(e, {
          title: '崩坏3 角色面板',
          subtitle: `UID ${uidValue}`,
          text: panel.text,
          portrait: panel.portrait,
          links: panel.links,
          characterPanel: panel.characterPanel,
        })
      }
      const card = buildCharactersCard(data)
      return this.replyWithCard(e, {
        title: '崩坏3 角色',
        subtitle: `UID ${uidValue}`,
        text: card.text,
        avatarGroups: card.avatarGroups,
      })
    }, uid)
  }

  async showAbyss(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(深渊|超弦)(\\s+(\\d{5,12}))?$`))
    return this.withUid(e, async (uidValue, cookie) => {
      const results = await Promise.allSettled([
        recordRequest('/index', uidValue, {}, cookie),
        recordRequest('/newAbyssReport', uidValue, {}, cookie),
        recordRequest('/latestOldAbyssReport', uidValue, {}, cookie),
      ])
      const pick = result => (result.status === 'fulfilled' ? result.value : null)
      const raw = {
        index: pick(results[0]),
        newAbyssReport: pick(results[1]),
        latestOldAbyssReport: pick(results[2]),
      }
      const cachedRegion = await CookieMgr.getCachedRegion(uidValue).catch(() => '')
      const data = buildAbyssBoard(raw, {
        uid: uidValue,
        server: raw.index?.role?.region || cachedRegion,
        nickname: '',
      })
      if (!data.empty) {
        const img = await this.renderMysHtml('html/bh3abyssnow', data)
        if (img) return replyMysCard(e, img)
      }
      // 图片渲染失败或暂无数据时回退文本卡片，保持旧行为
      const errors = results.slice(1)
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
      const legacyCards = []
      if (raw.newAbyssReport) legacyCards.push(buildAbyssCard(raw.newAbyssReport, '超弦空间'))
      if (raw.latestOldAbyssReport) legacyCards.push(buildAbyssCard(raw.latestOldAbyssReport, '量子奇点'))
      const text = legacyCards.map(card => card.text).filter(Boolean).join('\n')
      if (!text && errors.length > 0) {
        return e.reply(`深渊查询失败：${errors[0]?.message || "未知错误"}`)
      }
      return this.replyWithCard(e, {
        title: '崩坏3 深渊',
        subtitle: `UID ${uidValue}`,
        text: text || '暂无深渊数据。',
        avatarGroups: legacyCards.flatMap(card => card.avatarGroups),
      })
    }, String(match?.[4] || '').trim())
  }

  async showBattleField(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(战场|记忆战场)(\\s+(\\d{5,12}))?$`))
    return this.withUid(e, async (uid, cookie) => {
      const results = await Promise.allSettled([
        recordRequest('/index', uid, {}, cookie),
        recordRequest('/battleFieldReport', uid, {}, cookie),
      ])
      const pick = result => (result.status === 'fulfilled' ? result.value : null)
      const raw = {
        index: pick(results[0]),
        battleFieldReport: pick(results[1]),
      }
      const cachedRegion = await CookieMgr.getCachedRegion(uid).catch(() => '')
      const data = buildBattleFieldBoard(raw, {
        uid,
        server: raw.index?.role?.region || cachedRegion,
        nickname: '',
      })
      if (!data.empty) {
        const img = await this.renderMysHtml('html/bh3battlefield', data)
        if (img) return replyMysCard(e, img)
      }
      if (!raw.battleFieldReport && results[1].status === 'rejected') {
        return e.reply(`战场查询失败：${results[1].reason?.message || "未知错误"}`)
      }
      const card = buildBattleFieldCard(raw.battleFieldReport || {})
      return this.replyWithCard(e, {
        title: '崩坏3 记忆战场',
        subtitle: `UID ${uid}`,
        text: card.text,
        avatarGroups: card.avatarGroups,
      })
    }, String(match?.[4] || '').trim())
  }

  async showGodWar(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(逐光)(\\s+(\\d{5,12}))?$`))
    return this.withUid(e, async (uid, cookie) => {
      const results = await Promise.allSettled([
        recordRequest('/index', uid, {}, cookie),
        recordRequest('/godWar', uid, {}, cookie),
      ])
      const pick = result => (result.status === 'fulfilled' ? result.value : null)
      const raw = {
        index: pick(results[0]),
        godWar: pick(results[1]),
      }
      const cachedRegion = await CookieMgr.getCachedRegion(uid).catch(() => '')
      const data = buildGodWarBoard(raw, {
        uid,
        server: raw.index?.role?.region || cachedRegion,
        nickname: '',
      })
      if (!data.empty) {
        const img = await this.renderMysHtml('html/bh3godwar', data)
        if (img) return replyMysCard(e, img)
      }
      if (!raw.godWar && results[1].status === 'rejected') {
        return e.reply(`逐光查询失败：${results[1].reason?.message || "未知错误"}`)
      }
      const card = buildGodWarCard(raw.godWar || {})
      return this.replyWithCard(e, {
        title: '崩坏3 逐光',
        subtitle: `UID ${uid}`,
        text: card.text,
        stats: card.stats,
        avatarGroups: card.avatarGroups,
      })
    }, String(match?.[4] || '').trim())
  }

  async damageCommand(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(伤害|伤害计算)\\s+([\\s\\S]+)$`))
    const rest = String(match?.[3] || '').trim()
    const tokens = rest.split(/\s+/).filter(Boolean)
    if (tokens.length < 1) {
      return e.reply('用法：#崩坏3伤害 <角色名> [攻击力] [技能倍率%] [增伤%] [暴击率%] [暴击伤害%] [防御] [抗性%]\n攻击力可省略，省略时自动使用角色图鉴基础攻击。\n示例：#崩坏3伤害 薪炎之律者 300 50 100 150')
    }
    const name = tokens[0]
    const numbers = tokens.slice(1).map(token => Number(String(token).replace(/%/g, '')))
    const invalidIndex = numbers.findIndex(value => !Number.isFinite(value))
    if (invalidIndex !== -1) {
      return e.reply(`参数「${tokens[invalidIndex + 1]}」不是有效数字。\n用法：#崩坏3伤害 <角色名> [攻击力] [技能倍率%] [增伤%] [暴击率%] [暴击伤害%] [防御] [抗性%]`)
    }
    const character = findCharacter(name)
    if (!character) {
      const suggestions = searchCharacters(name).slice(0, 5)
      const hint = suggestions.length
        ? `，可输入：${suggestions.map(item => item.name).join('、')}`
        : ''
      return e.reply(`未找到角色「${name}」${hint}。`)
    }
    const attack = Number.isFinite(numbers[0]) ? numbers[0] : (character.baseAttack || 0)
    if (attack <= 0) {
      return e.reply(`角色「${character.name}」暂无数值数据，请手动提供攻击力：\n#崩坏3伤害 ${character.name} <攻击力> [倍率%]`)
    }
    const result = calculateDamage({
      attack,
      multiplier: numbers[1] ?? 100,
      bonus: numbers[2] ?? 0,
      critRate: numbers[3] ?? 100,
      critDamage: numbers[4] ?? 150,
      defense: numbers[5] ?? (character.element === '物理' ? 500 : 0),
      resistance: numbers[6] ?? 0,
      physical: character.element === '物理',
    })
    const lines = [
      `=== 伤害估算：${character.name} ===`,
      `元素：${character.element || '未知'} · 属性：${character.attribute || '未知'} · 武器：${character.weaponType || '未知'}`,
      '',
      Number.isFinite(numbers[0]) ? '' : `（攻击力未提供，自动使用图鉴基础攻击 ${result.attack}）`,
      `攻击力 ${result.attack} × 技能倍率 ${result.multiplier}%`,
      `增伤 ${result.bonus}% · 暴击率 ${result.critRate}% · 暴击伤害 ${result.critDamage}%`,
      result.physical
        ? `物理角色：防御减免 ${result.defenseReduction.toFixed(1)}%（按防御 ${result.defense} 估算）`
        : `元素角色：抗性减免 ${result.resistance}%`,
      '',
      `基础伤害：${Math.round(result.baseDamage)}`,
      `暴击伤害：${Math.round(result.critValue)}`,
      `期望伤害：${Math.round(result.expectedDamage)}`,
      '',
      '注：伤害为估算值，未计入队友加成、易伤、穿透与技能特性。',
    ]
    return this.replyWithCard(e, {
      title: '崩坏3 伤害计算',
      subtitle: character.name,
      text: lines.join('\n'),
      portrait: character.portrait || '',
      stats: [
        { label: '基础伤害', value: Math.round(result.baseDamage) },
        { label: '暴击伤害', value: Math.round(result.critValue) },
        { label: '期望伤害', value: Math.round(result.expectedDamage) },
      ],
    })
  }

  async characterArtCommand(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(角色图|立绘|背景图|图鉴卡)\\s+([\\s\\S]+)$`))
    const keyword = String(match?.[3] || '').trim()
    return e.reply(this.characterArchiveReply(keyword))
  }

  characterArchiveReply(keyword = '') {
    const character = findCharacter(keyword)
    if (!character) {
      const suggestions = searchCharacters(keyword).slice(0, 5)
      const hint = suggestions.length
        ? `，可输入：${suggestions.map(item => item.name).join('、')}`
        : ''
      return `未找到角色「${keyword}」${hint}。`
    }
    const seg = globalThis.segment
    const images = []
    const push = url => {
      if (url && /^https?:\/\//.test(String(url)) && seg?.image) {
        images.push(seg.image(String(url)))
      }
    }
    push(character.background)
    push(character.portrait)
    push(character.icon)
    const aliasText = character.aliases?.length ? `别名：${character.aliases.join('、')}` : ''
    const hexagon = character.hexagon && Object.keys(character.hexagon).length
      ? `\n六维：${Object.entries(character.hexagon).map(([key, value]) => `${key}${value}`).join(' / ')}`
      : ''
    const text = [
      `=== ${character.name} ===`,
      aliasText,
      `元素：${character.element || '未知'} · 属性：${character.attribute || '未知'}`,
      `武器：${character.weaponType || '未知'} · 初始阶级：${character.rarity || '未知'}`,
      `定位：${character.role || '未知'}`,
      hexagon,
    ].filter(Boolean).join('\n')
    if (images.length === 0) {
      return text
    }
    return [...images, text]
  }

  formatSingleCharacter(data = {}, keyword = '', uid = '') {
    const list = Array.isArray(data.characters) ? data.characters : []
    const matches = list.filter(item => {
      const name = String(item.character?.avatar?.name || '')
      const dbHit = findCharacter(keyword)
      return name === keyword || name.includes(keyword) || (dbHit && name === dbHit.name)
    })
    if (matches.length === 0) {
      return { text: `UID ${uid} 下未找到角色「${keyword}」。`, portrait: '', links: [], characterPanel: null }
    }
    const first = matches[0].character || {}
    const avatar = first.avatar || {}
    const weapon = first.weapon || {}
    const stigmatas = Array.isArray(first.stigmatas) ? first.stigmatas : []
    const elf = first.elf || {}
    const dbChar = findCharacter(avatar.name || keyword)
    const links = avatar.wiki_url ? [avatar.wiki_url] : []
    const hexagon = dbChar?.hexagon
      ? Object.entries(dbChar.hexagon).map(([key, value]) => ({ key, value }))
      : []
    return {
      text: matches.length > 1 ? `共找到 ${matches.length} 名匹配角色，显示首位。` : '',
      portrait: dbChar?.portrait || '',
      links: Array.from(new Set(links)),
      characterPanel: {
        avatar: avatar.figure_path || avatar.background_path || avatar.icon_path || '',
        name: avatar.name || '未知角色',
        level: avatar.level,
        star: avatar.star,
        attribute: dbChar?.attribute || ATTRIBUTE_MAP[Number(avatar.attribute_id)] || '',
        element: dbChar?.element || '',
        rarity: dbChar?.rarity || '',
        weaponType: dbChar?.weaponType || '',
        baseAttack: dbChar?.baseAttack || '',
        weapon: weapon?.name
          ? { name: weapon.name, img: weapon.icon || '', rarity: weapon.rarity ?? weapon.max_rarity }
          : null,
        stigmatas: stigmatas.map(item => ({
          name: item.name || '',
          img: item.icon || '',
          rarity: item.rarity,
        })),
        elf: elf?.name
          ? { name: elf.name, img: elf.avatar || '', rarity: elf.rarity }
          : null,
        hexagon,
      },
    }
  }

  async wikiSearchCommand(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(图鉴|查询|wiki)\\s+([\\s\\S]+)$`))
    return this.searchWiki(e, String(match?.[3] || '').trim(), '')
  }

  async wikiSearchByType(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}(角色图鉴|武器图鉴|圣痕图鉴|人偶图鉴|协同者图鉴)\\s+([\\s\\S]+)$`))
    const type = String(match?.[2] || '')
    const keyword = String(match?.[3] || '').trim()
    return this.searchWiki(e, keyword, type)
  }

  async wikiDetailCommand(e) {
    const match = String(e.msg || '').match(new RegExp(`^${PREFIX}图鉴详情\\s+(\\d+)\\s*$`))
    const id = match?.[2] || ''
    try {
      const detail = await wikiDetail(id)
      if (!detail?.id) {
        return e.reply('未找到该图鉴条目。')
      }
      const text = formatWikiDetail(detail)
      return this.replyWithCard(e, {
        title: '崩坏3 图鉴',
        subtitle: `条目 #${detail.id}`,
        text,
        portrait: detail.icon || '',
        links: detail.bbs_url ? [detail.bbs_url] : [],
      })
    } catch (error) {
      return e.reply(`图鉴查询失败：${error.message}`)
    }
  }

  async searchWiki(e, keyword = '', type = '') {
    if (!keyword) {
      return e.reply('请提供要查询的关键词，例如：#崩坏3图鉴 琪亚娜')
    }
    try {
      const dbHit = findCharacter(keyword)
      const searchKeyword = dbHit ? dbHit.name : keyword
      let results = await wikiSearch(searchKeyword)
      if (type) {
        const keywords = {
          角色图鉴: ['女武神', '角色'],
          武器图鉴: ['武器'],
          圣痕图鉴: ['圣痕'],
          人偶图鉴: ['人偶'],
          协同者图鉴: ['协同者'],
        }
        const filter = keywords[type] || []
        const matched = results.filter(item => filter.some(word => item.channel?.includes(word) || item.parent?.includes(word)))
        if (matched.length > 0) {
          results = matched
        }
      }
      if (results.length === 0) {
        return e.reply(`未找到与「${keyword}」相关的图鉴内容。`)
      }
      if (results.length === 1) {
        const detail = await wikiDetail(results[0].id)
        const text = formatWikiDetail(detail)
        return this.replyWithCard(e, {
          title: '崩坏3 图鉴',
          subtitle: `${results[0].parent}/${results[0].channel}`,
          text,
          portrait: detail.icon || '',
          links: detail.bbs_url ? [detail.bbs_url] : [],
        })
      }
      const lines = [`找到 ${results.length} 条与「${keyword}」相关的内容：`, '']
      for (const item of results.slice(0, 8)) {
        const channel = item.parent ? `${item.parent}/${item.channel}` : item.channel
        lines.push(`[${item.id}] ${item.title}${channel ? `（${channel}）` : ''}`)
      }
      lines.push('', '发送 #崩坏3图鉴详情 <编号> 查看详情。')
      return this.replyWithCard(e, {
        title: '崩坏3 图鉴搜索',
        subtitle: `关键词：${keyword}`,
        text: lines.join('\n'),
        links: results.slice(0, 8).map(item => item.bbs_url).filter(Boolean),
      })
    } catch (error) {
      return e.reply(`图鉴查询失败：${error.message}`)
    }
  }

  // ==================== 以下为 honkai-mys 移植功能 ====================

  /** 获取目标用户(@指定的用户或自己) */
  async getMysTargetUser(e = {}) {
    const at = String(e.at || '')
    if (at && /^\d+$/.test(at)) {
      // 允许 @自己；@他人 仅限主人，避免任意群友读取他人的手账/抽卡记录
      if (at !== String(e.user_id) && !isMaster(e)) {
        throw new InfoError('只能查询自己的账号；如需查询他人，请让 Bot 主人操作。')
      }
      try {
        const atUser = await e.runtime.NoteUser.create(at)
        if (atUser) return atUser
      } catch (err) {
        globalThis.logger?.error?.('[bh3] 获取@用户数据失败', err)
      }
    }
    return e.user
  }

  /** 解析命令参数,返回 { uid, server, cookie }(honkai-mys 方式) */
  async resolveMysRole(e, text = '') {
    const user = await this.getMysTargetUser(e)
    // 米游社id
    if (/[mM][yY][sS]|米游社/.test(text)) {
      const m = text.match(/\d{4,}/)
      if (!m) throw new InfoError('米游社ID格式不对')
      const cookie = CookieMgr.getFirstCk(user)
      if (!cookie) throw new InfoError('请先绑定Cookie，发送【#绑定Cookie】获取教程')
      const role = await Bh3.mys2Role(cookie, m[0])
      return { uid: role.game_role_id, server: role.region, cookie, nickname: role.nickname }
    }

    // UID 需独立成段（前后不能再接数字），避免 11 位 UID 被截断、5 位 UID 被忽略
    const uidMatch = text.match(/(?<!\d)\d{5,12}(?!\d)/)
    const serverMatch = text.match(/[^\d\s]+/)

    // 未提供uid: 使用绑定的Cookie账号
    if (!uidMatch) {
      const role = await CookieMgr.getSelfBh3Role(user)
      return { uid: role.uid, server: role.server, cookie: role.cookie, nickname: role.nickname }
    }

    const uid = uidMatch[0]

    // 提供了服务器: 直接使用(优先该 uid 登记过的 Cookie)
    if (serverMatch) {
      const cookie = CookieMgr.getCkByUid(user, uid) || CookieMgr.getFirstCk(user)
      if (!cookie) throw new InfoError('请先绑定Cookie，发送【#绑定Cookie】获取教程')
      return { uid, server: server2id(serverMatch[0]), cookie }
    }

    // 未提供服务器: 自动识别所属服务器与可用 Cookie
    const found = await CookieMgr.findRoleByUid(user, uid)
    if (found) return { uid, server: found.server, cookie: found.cookie }

    throw new InfoError(
      `未能自动识别 UID ${uid} 所在服务器：请确认已用该账号绑定 Cookie，或补充服务器，如：#崩坏3 ${uid}官服`,
    )
  }

  /** 使用 honkai-mys 的 HTML 模板渲染(高分辨率，失败回退框架渲染) */
  async renderMysHtml(tpl, data) {
    const name = String(tpl).replace(/^html\//, '')
    try {
      const imgPath = await renderMysTemplate(name, data)
      const seg = globalThis.segment
      return seg?.image ? seg.image(imgPath) : imgPath
    } catch (err) {
      globalThis.logger?.warn?.(`[bh3] 高分辨率渲染失败，回退框架渲染: ${err.message}`)
    }

    let fallback = null
    try {
      fallback = await this.renderImg('bh3-plugin', `html/${name}`, data, { retType: 'base64', scale: DEVICE_SCALE })
    } catch (fallbackError) {
      globalThis.logger?.error?.('[bh3] renderImg 失败', fallbackError)
    }
    // renderImg 截图失败时返回 false 而不是抛错，必须显式判空后再走 runtime 兜底
    if (fallback) return fallback

    try {
      const runtimeImg = await e_runtimeRender(this.e, `html/${name}`, data)
      if (runtimeImg) return runtimeImg
    } catch (runtimeError) {
      globalThis.logger?.error?.('[bh3] runtime.render 亦失败', runtimeError)
    }
    return null
  }

  /** #崩坏3 / #bh3 玩家卡片 */
  async mysCard(e) {
    const text = stripMysKeyword(e.msg)
    let role
    try {
      role = await this.resolveMysRole(e, text)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    let raw
    try {
      raw = await new Bh3(role.cookie).part(role.uid, role.server)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    const img = await this.renderMysHtml('html/bh3card', buildIndexCard(raw, role))
    return replyMysCard(e, img)
  }

  /** #崩坏3角色 / #bh3角色 拥有的女武神列表 */
  async mysChara(e) {
    const text = stripMysKeyword(e.msg, '角色')
    let role
    try {
      role = await this.resolveMysRole(e, text)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    const api = new Bh3(role.cookie)
    let raw
    try {
      const [index, characters] = await Promise.all([
        api.index(role.uid, role.server),
        api.characters(role.uid, role.server),
      ])
      raw = { index, characters }
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    const img = await this.renderMysHtml('html/bh3chara', buildMysCharaCard(raw, role))
    return replyMysCard(e, img)
  }

  /** #崩坏3体力 / #崩坏3便笺 实时便签(honkai-mys 卡片) */
  async mysNote(e) {
    const text = stripMysKeyword(e.msg, '(体力|便签|便笺|实时便签|实时便笺)')
    let role
    try {
      role = await this.resolveMysRole(e, text)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    let raw
    try {
      raw = await new Bh3(role.cookie).note(role.uid, role.server)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    const img = await this.renderMysHtml('html/bh3note', buildNoteCard(raw, role))
    return replyMysCard(e, img)
  }

  /** #崩坏3战报 舰长战报 */
  async mysReport(e) {
    const text = stripMysKeyword(e.msg, '(舰长战报|战报)')
    let role
    try {
      role = await this.resolveMysRole(e, text)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    let raw
    try {
      raw = await new Bh3(role.cookie).part(role.uid, role.server)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    saveReports(role.uid, extractReportHistory(raw))
    const img = await this.renderMysHtml('html/bh3report', buildReportCard(raw, role))
    return replyMysCard(e, img)
  }

  /** #崩坏3深渊战报 / #崩坏3战场战报(更多近期记录) */
  async mysBranchReport(e) {
    const isAbyss = /深渊战报/.test(e.msg)
    const text = stripMysKeyword(e.msg, '(深渊战报|战场战报)')
    let role
    try {
      role = await this.resolveMysRole(e, text)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    let raw
    try {
      raw = await new Bh3(role.cookie).part(role.uid, role.server)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    saveReports(role.uid, extractReportHistory(raw))
    const history = getReports(role.uid)
    const data = isAbyss ? buildMysAbyssCard(raw, role, history) : buildMysBattleCard(raw, role, history)
    const img = await this.renderMysHtml(isAbyss ? 'html/bh3abyss' : 'html/bh3battle', data)
    return replyMysCard(e, img)
  }

  /** #崩坏3一周成绩单(当前 + 本地历史) */
  async mysWeekly(e) {
    const text = stripMysKeyword(e.msg, '(一周成绩单|成绩单)')
    let role
    try {
      role = await this.resolveMysRole(e, text)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    let raw
    try {
      raw = await new Bh3(role.cookie).part(role.uid, role.server)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    saveReports(role.uid, extractReportHistory(raw))
    const img = await this.renderMysHtml('html/bh3weekly', buildWeeklyCard(raw, getReports(role.uid), role))
    return replyMysCard(e, img)
  }

  /** #崩坏3手帐 水晶手账 */
  async mysFinance(e) {
    const text = stripMysKeyword(e.msg, '(手帐|手账)')
    if (/[?？]/.test(text)) {
      return e.reply(
        '水晶手账查询\n发送 #崩坏3手帐 / #bh3手帐 使用绑定的Cookie账号查询\n#崩坏3手帐@他人 可查询对方手账\n(账号需绑定崩坏3角色)',
        false,
        { at: true },
      )
    }
    let role
    try {
      role = await CookieMgr.getSelfBh3Role(await this.getMysTargetUser(e))
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    const api = new Bh3(role.cookie)
    let raw
    let nickname = role.nickname || ''
    try {
      const [finance, index] = await Promise.all([
        api.finance(role.uid, role.server),
        api.index(role.uid, role.server).catch(() => null),
      ])
      raw = finance
      nickname = index?.role?.nickname || nickname
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    const data = buildFinanceCard(raw)
    data.nickname = nickname || '舰长'
    const img = await this.renderMysHtml('html/bh3finance', data)
    return replyMysCard(e, img)
  }

  /** 记录查询上下文: 角色 + stoken + 自助查询接口 */
  async mysRecordContext(e) {
    const user = await this.getMysTargetUser(e)
    const role = await CookieMgr.getSelfBh3Role(user)
    let stoken = false
    for (const ltuid of Object.keys(user.mysUsers || {})) {
      stoken = getStokenByLtuid(ltuid)
      if (stoken) break
    }
    if (!stoken) throw new InfoError('未找到 stoken，无法更新记录。请先在逍遥插件绑定 stoken 后再试')
    const authkey = await genAuthKey(role.uid, role.server, stoken)
    return { role, api: new SelfHelp(authkey, role.uid) }
  }

  /** #崩坏3更新抽卡/补给记录 */
  async mysUpdateGacha(e) {
    return this.updateMysRecord(e, 'gacha')
  }

  /** #崩坏3更新道具记录 */
  async mysUpdateMaterial(e) {
    return this.updateMysRecord(e, 'material')
  }

  async updateMysRecord(e, category) {
    const name = category === 'gacha' ? '抽卡/补给' : '道具'
    let ctx
    try {
      ctx = await this.mysRecordContext(e)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    await e.reply(`正在更新${name}记录，请稍后…`)
    let result
    try {
      result = await updateRecords(ctx.api, ctx.role.uid, category)
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    const added = result.reduce((n, r) => n + r.added, 0)
    const lines = result.map(r => `· ${r.label}：新增 ${r.added} 条（共 ${r.total} 条）`)
    const tip = category === 'gacha' ? '抽卡' : '道具'
    return e.reply(
      `【崩坏3 ${name}记录】更新完成，共新增 ${added} 条\n${lines.join('\n')}\n发送 #bh3${tip}记录 查看`,
      false,
      { at: true },
    )
  }

  /** #崩坏3抽卡/补给记录 [角色|装备|家园] */
  async mysGacha(e) {
    return this.showMysRecord(e, 'gacha', { pool: stripMysKeyword(e.msg, '(抽卡记录|补给记录)') })
  }

  /** #崩坏3抽卡统计 / #崩坏3补给统计 */
  async mysGachaStat(e) {
    return this.showMysRecord(e, 'gacha', { statOnly: true })
  }

  /** #崩坏3道具记录 */
  async mysMaterial(e) {
    return this.showMysRecord(e, 'material')
  }

  async showMysRecord(e, category, { pool = '', statOnly = false } = {}) {
    const name = category === 'gacha' ? '抽卡/补给' : '道具'
    let role
    try {
      role = await CookieMgr.getSelfBh3Role(await this.getMysTargetUser(e))
    } catch (err) {
      return e.reply(err.message, false, { at: true })
    }
    let groups = collectRecords(role.uid, category)
    if (pool) {
      const matched = groups.filter(g => g.label.includes(pool))
      if (matched.length) groups = matched
    }
    if (!groups.some(g => g.records.length)) {
      const tip = category === 'gacha' ? '抽卡' : '道具'
      return e.reply(`暂无${name}记录，请先发送「#bh3更新${tip}记录」`, false, { at: true })
    }

    let nickname = role.nickname || ''
    let avatarUrl = ''
    try {
      const idx = await new Bh3(role.cookie).index(role.uid, role.server)
      nickname = idx?.role?.nickname || nickname
      avatarUrl = idx?.role?.AvatarUrl || ''
    } catch {
      /* ignore */
    }

    if (category === 'gacha') {
      const data = buildGachaCard({
        groups,
        nickname,
        uid: role.uid,
        serverName: id2server(role.server),
        avatarUrl,
      })
      const img = await this.renderMysHtml('html/bh3gacha', data)
      return replyMysCard(e, img)
    }

    const data = buildRecordCard({
      category,
      groups,
      nickname,
      uid: role.uid,
      serverName: id2server(role.server),
      avatarUrl,
      statOnly,
    })
    const img = await this.renderMysHtml('html/bh3record', data)
    return replyMysCard(e, img)
  }
}

/** 调用 runtime 渲染(honkai-mys 回退路径) */
function e_runtimeRender(ctx, path, data) {
  return ctx.runtime.render('bh3-plugin', path, data, { retType: 'base64' })
}
