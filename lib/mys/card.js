import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { abyssLevel, areaName, fmtDate, id2server } from "./api.js"
import { mergeEntries } from "./store.js"

const __rarityDir = path.dirname(fileURLToPath(import.meta.url))
/** 资源目录: plugins/bh3-plugin/resources */
const RES_DIR = path.join(__rarityDir, "..", "..", "resources")
/** 崩坏3装备/角色稀有度(来自米游社百科图鉴) */
const RARITY = { characters: {}, weapons: {}, stigmata: {} }
/** 归一化后的稀有度表(去除空格/统一括号) */
const NORM = { characters: {}, weapons: {}, stigmata: {} }

/** 名称归一化: 去空格、全角括号转半角 */
function normName(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
}

/** 武器别名: 游戏内名称 -> 图鉴名称 */
const WEAPON_ALIAS = { 镜见之钥: "镜见之境" }

try {
  const raw = JSON.parse(fs.readFileSync(path.join(RES_DIR, "bh3_rarity.json"), "utf8"))
  for (const group of ["characters", "weapons", "stigmata"]) {
    for (const [k, v] of Object.entries(raw[group] || {})) {
      NORM[group][normName(k)] = v
      RARITY[group][k] = v
    }
  }
} catch {
  /* ignore */
}

/** 图鉴图标(名称归一化 -> 图片URL) */
const ICON = { characters: {}, weapons: {}, stigmata: {}, synergy: {} }
/** 协同者名称集合(归一化), 用于识别协同补给 */
const SYNERGY = new Set()
try {
  const raw = JSON.parse(fs.readFileSync(path.join(RES_DIR, "bh3_icons.json"), "utf8"))
  for (const group of ["characters", "weapons", "stigmata", "synergy"]) {
    for (const [k, v] of Object.entries(raw[group] || {})) {
      ICON[group][normName(k)] = v
      if (group === "synergy") SYNERGY.add(normName(k))
    }
  }
} catch {
  /* ignore */
}

/** 依据类型/名称推断星级(角色: S=5 A=4 B=3; 装备: 5/4/3) */
export function gachaStar(type, name) {
  const key0 = normName(name)
  if (type === "角色") {
    const rank = NORM.characters[key0]
    if (rank === "S") return 5
    if (rank === "A") return 4
    if (rank === "B") return 3
    return 4
  }
  if (type === "武器") {
    const key = normName(WEAPON_ALIAS[key0] || key0)
    return NORM.weapons[key] || NORM.weapons[key.split("：")[0]] || 3
  }
  if (type === "圣痕") return NORM.stigmata[key0] || 3
  return 3
}

/** 依据类型/名称获取图鉴图标URL */
export function gachaIcon(type, name) {
  const key0 = normName(name)
  if (SYNERGY.has(key0)) return ICON.synergy[key0] || ""
  if (type === "角色") return ICON.characters[key0] || ""
  if (type === "武器") {
    const alias = WEAPON_ALIAS[key0]
    return ICON.weapons[key0] || (alias && ICON.weapons[normName(alias)]) || ICON.weapons[key0.split("：")[0]] || ""
  }
  if (type === "圣痕") return ICON.stigmata[key0] || ""
  return ""
}

/** 名称是否协同者(用于协同补给出货判定) */
export function isSynergy(name) {
  return SYNERGY.has(normName(name))
}

/** 女武神星级 -> 文字 */
export function rankName(star) {
  const map = { 1: "B", 2: "A", 3: "S", 4: "SS", 5: "SSS" }
  return map[star] || ""
}

/** 装备星级 -> ★字符 */
export function starStr(rarity = 0, max = 0) {
  const n = Math.max(0, Math.min(rarity || 0, max || 0))
  return "★".repeat(n) + "☆".repeat(Math.max(0, (max || 0) - n))
}

/** 综合评级 -> 显示文本 */
function rateName(rate) {
  const map = { C: "C", B: "B", A: "A", S: "S" }
  return map[rate] || ""
}

/** 千分位 */
function nf(num) {
  return (Number(num) || 0).toLocaleString("zh-CN")
}

/** 手账环形图(conic-gradient) */
export function buildRing(percentList) {
  const colors = ["#d64d94", "#b23ac4", "#8e35c9", "#f0a6e0", "#c98ae8", "#a35fd0", "#ff9edb"]
  if (!percentList || !percentList.length) return ""
  let sum = 0
  for (const p of percentList) sum += Number(p) || 0
  if (!sum) return ""
  let start = 0
  const stops = []
  percentList.forEach((p, i) => {
    const end = start + (Number(p) / sum) * 100
    const color = colors[i % colors.length]
    stops.push(`${color} ${start}% ${end}%`)
    start = end
  })
  return `conic-gradient(${stops.join(",")})`
}

/** 手账卡片数据 */
export function buildFinanceCard(raw) {
  const cur = raw.index || {}
  const last = raw.getLastMonthInfo || {}
  const curDate = cur.date ? String(cur.date).slice(0, 10) : ""

  const group = (last.group_by || []).map((g, i) => ({
    name: g.name || "其他",
    num: g.num || 0,
    percent: g.percent ?? 0,
    color: ["#d64d94", "#b23ac4", "#8e35c9", "#f0a6e0", "#c98ae8", "#a35fd0", "#ff9edb"][i % 7],
  }))

  return {
    uid: cur.uid || "",
    month: cur.month ?? "",
    date: curDate,
    monthHcoin: nf(cur.month_hcoin),
    monthStar: nf(cur.month_star),
    monthLevel: cur.month_level ?? "",
    dayHcoin: cur.day_hcoin ?? 0,
    dayStar: cur.day_star ?? 0,
    todayText:
      cur.day_hcoin || cur.day_star
        ? `今日已获取 ${nf(cur.day_hcoin)} 水晶 · ${nf(cur.day_star)} 星石`
        : "今日还没有收入哦",
    lastHcoin: nf(cur.last_hcoin),
    lastStar: nf(cur.last_star),
    // 补给卡数量
    cardCount: raw.cardCount ?? null,
    lastCardCount: raw.lastCardCount ?? null,
    hasCardCount: raw.cardCount != null || raw.lastCardCount != null,
    // 上月
    lastMonth: last.month ?? "",
    lastDate: `${String(last.month_start || "").slice(0, 10)} 至 ${String(last.month_end || "").slice(0, 10)}`,
    lastMonthHcoin: nf(last.month_hcoin),
    lastMonthStar: nf(last.month_star),
    hcoinRate: last.hcoin_rate,
    starRate: last.star_rate,
    group,
    ring: buildRing(group.map(g => g.percent)),
  }
}

/** 秒 -> 中文时长 */
export function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0))
  if (!sec) return ""
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  let s = ""
  if (d > 0) s += `${d}天`
  if (h > 0) s += `${h}时`
  if (d === 0 && m > 0) s += `${m}分`
  return s || "即将结束"
}

/** 结算时间戳 -> 剩余时间文案 */
function scheduleRemain(ts) {
  let end = Number(ts)
  if (!end) return ""
  if (end > 1e12) end = Math.floor(end / 1000)
  const remain = end - Math.floor(Date.now() / 1000)
  if (remain <= 0) return "已结束"
  return `剩余 ${fmtDuration(remain)}`
}

/** 实时便签卡片数据 */
export function buildNoteCard(raw, { uid, server, nickname }) {
  const n = raw || {}
  const curStamina = n.current_stamina ?? 0
  const maxStamina = n.max_stamina || 0
  const staminaFull = maxStamina > 0 && curStamina >= maxStamina
  const recover = Number(n.stamina_recover_time) || 0
  const staminaPercent = maxStamina ? Math.round(Math.max(0, Math.min(1, curStamina / maxStamina)) * 100) : 0

  const curTrain = n.current_train_score ?? 0
  const maxTrain = n.max_train_score ?? 0

  const has = obj => obj && typeof obj === "object" && Object.keys(obj).length > 0
  const activities = []

  if (has(n.ultra_endless)) {
    const a = n.ultra_endless
    activities.push({
      name: "超弦空间",
      open: !!a.is_open,
      value: a.challenge_score ?? "-",
      valueLabel: "挑战积分",
      remain: scheduleRemain(a.schedule_end),
    })
  } else if (has(n.greedy_endless)) {
    const a = n.greedy_endless
    activities.push({
      name: "量子流形",
      open: !!a.is_open,
      value: `${a.cur_reward ?? 0} / ${a.max_reward ?? 0}`,
      valueLabel: "奖励进度",
      remain: scheduleRemain(a.schedule_end),
    })
  }
  if (has(n.battle_field)) {
    const a = n.battle_field
    activities.push({
      name: "记忆战场",
      open: !!a.is_open,
      value: `${a.cur_reward ?? 0} / ${a.max_reward ?? 0}`,
      valueLabel: "奖励进度",
      remain: scheduleRemain(a.schedule_end),
    })
  }
  if (has(n.god_war)) {
    const a = n.god_war
    activities.push({
      name: "往世乐土",
      open: !!a.is_open,
      value: `${a.cur_reward ?? 0} / ${a.max_reward ?? 0}`,
      valueLabel: "奖励进度",
      remain: scheduleRemain(a.schedule_end),
    })
  }

  return {
    uid,
    serverName: id2server(server),
    nickname: nickname || "",
    stamina: curStamina,
    maxStamina,
    staminaFull,
    staminaPercent,
    recoverText: staminaFull ? "体力已回满" : recover > 0 ? `体力回满还需 ${fmtDuration(recover)}` : "体力已回满",
    train: curTrain,
    maxTrain,
    trainPercent: maxTrain ? Math.round(Math.max(0, Math.min(1, curTrain / maxTrain)) * 100) : 0,
    trainDone: maxTrain > 0 && curTrain >= maxTrain,
    activities,
  }
}

/** 雷达图SVG */
export function buildRadarSvg(labels, values) {
  const size = 260
  const cx = size / 2
  const cy = size / 2
  const r = 92
  const n = Math.min(labels.length, values.length)
  const clamp = v => Math.max(0, Math.min(Number(v) || 0, 100))

  const point = (i, ratio) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n
    return [cx + Math.sin(ang) * r * ratio, cy - Math.cos(ang) * r * ratio]
  }

  // 网格(25/50/75/100)
  let grid = ""
  for (const ratio of [0.25, 0.5, 0.75, 1]) {
    const pts = []
    for (let i = 0; i < n; i++) pts.push(point(i, ratio).join(","))
    grid += `<polygon points="${pts.join(" ")}" fill="none" stroke="rgba(142,47,104,.18)" stroke-width="1"/>`
  }
  // 轴线
  let axes = ""
  for (let i = 0; i < n; i++) {
    const [x, y] = point(i, 1)
    axes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(142,47,104,.18)" stroke-width="1"/>`
  }
  // 数据多边形
  const dataPts = []
  for (let i = 0; i < n; i++) dataPts.push(point(i, clamp(values[i]) / 100))
  const dataPoly =
    `<polygon points="${dataPts.map(p => p.join(",")).join(" ")}" fill="rgba(178,58,196,.32)" stroke="#b23ac4" stroke-width="2"/>` +
    dataPts
      .map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#fff" stroke="#b23ac4" stroke-width="2"/>`)
      .join("")
  // 标签
  let label = ""
  for (let i = 0; i < n; i++) {
    const [x, y] = point(i, 1.28)
    label += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="13" fill="rgba(87,32,74,.85)">${labels[i]} ${clamp(values[i])}</text>`
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${grid}${axes}${dataPoly}${label}</svg>`
}

/** 深渊战报 -> 展示数据 */
export function mapAbyssReports(abyss, limit = 3) {
  if (!abyss?.reports?.length) return []
  return abyss.reports.slice(0, limit).map(r => ({
    type: r.type === "Greedy" ? "量子流形" : r.type === "OW" ? "迪拉克之海" : r.type === "Quantum" ? "量子奇点" : "超弦空间",
    bossName: r.boss?.name || "",
    bossAvatar: r.boss?.avatar || "",
    score: r.score ?? "",
    floor: r.floor,
    rank: r.rank,
    cup: r.settled_cup_number ?? r.cup_number,
    settledCup: r.settled_cup_number,
    level: abyssLevel(r.settled_level ?? r.level),
    rewardType: r.reward_type,
    time: fmtDate(r.updated_time_second || r.time_second),
    lineup: (r.lineup || []).slice(0, 4).map(a => ({
      icon: a.icon_path || a.avatar_background_path,
      name: a.name,
      star: a.star,
    })),
    elf: r.elf ? { avatar: r.elf.avatar, name: r.elf.name, star: r.elf.star } : null,
  }))
}

/** 战场战报 -> 展示数据 */
export function mapBattleFieldInfos(bf) {
  if (!bf) return []
  return (bf.battle_infos || []).map(b => ({
    bossName: b.boss?.name || "",
    bossAvatar: b.boss?.avatar || "",
    score: b.score ?? "",
    elf: b.elf ? { avatar: b.elf.avatar, name: b.elf.name, star: b.elf.star } : null,
    lineup: (b.lineup || []).map(a => ({
      bg: a.background_path || a.avatar_background_path,
      icon: a.icon_path,
      name: a.name,
      star: a.star,
    })),
  }))
}

/** 战场战报 -> 多期展示数据 */
export function mapBattleFieldReports(reports, limit = 3) {
  if (!reports?.length) return []
  return reports.slice(0, limit).map(bf => ({
    area: areaName(bf.area),
    pct: bf.ranking_percentage,
    score: bf.score,
    rank: bf.rank,
    time: fmtDate(bf.time_second),
    infos: mapBattleFieldInfos(bf),
  }))
}

/** 玩家卡片数据 */
export function buildIndexCard(raw, { uid, server }) {
  const { index, weeklyReport, newAbyssReport, latestOldAbyssReport, battleFieldReport } = raw
  const role = index?.role || {}
  const stats = index?.stats || {}
  const pref = index?.preference || {}
  const week = weeklyReport || {}

  // 深渊战报: 超弦空间优先,否则旧深渊
  let abyss = null
  if (newAbyssReport?.reports?.length) abyss = newAbyssReport
  else if (latestOldAbyssReport?.reports?.length) abyss = latestOldAbyssReport

  const abyssReports = mapAbyssReports(abyss, 3)

  const bf = battleFieldReport?.reports?.[0]
  const bfInfos = mapBattleFieldInfos(bf)

  const radarLabels = pref.is_god_war_unlock
    ? ["战场", "深渊", "乐土", "开放世界", "社区", "主线"]
    : ["战场", "深渊", "开放世界", "社区", "主线"]
  const radarValues = pref.is_god_war_unlock
    ? [pref.battle_field, pref.abyss, pref.god_war, pref.open_world, pref.community, pref.main_line]
    : [pref.battle_field, pref.abyss, pref.open_world, pref.community, pref.main_line]

  return {
    uid,
    serverName: id2server(server),
    avatarUrl: role.AvatarUrl || "",
    headBg: index?.head_background || "",
    nickname: role.nickname || "未知舰长",
    level: role.level || 0,
    // 数据总览
    activeDays: stats.active_day_number || 0,
    armorNum: stats.armor_number || 0,
    weaponNum: stats.weapon_number || 0,
    suitNum: stats.suit_number || 0,
    sssNum: stats.sss_armor_number || 0,
    stigmaNum: stats.stigmata_number || 0,
    // 深渊
    abyssLevel: stats.new_abyss ? abyssLevel(stats.new_abyss.level) : "无数据",
    abyssCup: stats.new_abyss ? stats.new_abyss.cup_number : null,
    // 战场
    bfArea: areaName(stats.battle_field_area),
    bfScore: stats.battle_field_score,
    bfPct: stats.battle_field_ranking_percentage,
    // 乐土
    gwUnlock: !!pref.is_god_war_unlock,
    gwSupport: stats.god_war_max_support_point,
    gwScore: stats.god_war_max_challenge_score,
    gwLevel: stats.god_war_max_level_avatar_number,
    gwItems: stats.god_war_extra_item_number,
    // 舰长偏好
    radarSvg: buildRadarSvg(radarLabels, radarValues),
    compScore: pref.comprehensive_score ?? "—",
    compRating: rateName(pref.comprehensive_rating),
    // 本周最爱角色
    favName: week.favorite_character?.name || "",
    favImg: week.favorite_character?.large_background_path || "",
    // 深渊战报
    abyssReports,
    // 战场战报
    bfInfo: bf
      ? {
          area: areaName(bf.area),
          pct: bf.ranking_percentage,
          score: bf.score,
          time: fmtDate(bf.time_second),
        }
      : null,
    bfInfos,
  }
}

/** 时间戳(秒/毫秒) -> YYYY-MM-DD */
function fmtTs(v) {
  const n = Number(v)
  if (!n || Number.isNaN(n)) return ""
  return fmtDate(n > 1e12 ? Math.floor(n / 1000) : n)
}

/** 一周成绩单 -> 展示数据(起止日期取接口 time_from/time_to) */
function mapWeekly(week = {}) {
  const fav = week.favorite_character || null
  const start = fmtTs(week.time_from)
  const end = fmtTs(week.time_to)
  return {
    favName: fav?.name || "",
    favImg: fav?.large_background_path || fav?.background_path || "",
    goldIncome: nf(week.gold_income),
    goldExpenditure: nf(week.gold_expenditure),
    activeDays: week.active_day_number ?? 0,
    onlineHours: week.online_hours ?? 0,
    stamina: nf(week.expended_physical_power),
    mainLinePct: week.main_line_expended_physical_power_percentage ?? 0,
    start,
    end,
    range: start && end ? `${start} ~ ${end}` : start || "",
  }
}

/** 当前周的周一日期(北京时间, YYYY-MM-DD) */
function weekKey(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000)
  const diff = (bj.getUTCDay() + 6) % 7
  bj.setUTCDate(bj.getUTCDate() - diff)
  const y = bj.getUTCFullYear()
  const m = String(bj.getUTCMonth() + 1).padStart(2, "0")
  const d = String(bj.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** 周一日期 -> 该周起止日期 { start, end } (end = start + 6天) */
function weekRange(key) {
  const start = String(key || "")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { start, end: "" }
  const d = new Date(`${start}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return { start, end: "" }
  d.setUTCDate(d.getUTCDate() + 6)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return { start, end: `${y}-${m}-${dd}` }
}

/** 从战报原始数据中提取需持久化的历史(带去重key) */
export function extractReportHistory(raw) {
  const { weeklyReport, newAbyssReport, latestOldAbyssReport, battleFieldReport } = raw
  const weekly = weeklyReport
    ? { key: String(weeklyReport.time_from || weekKey()), data: weeklyReport }
    : null

  let abyss = null
  if (newAbyssReport?.reports?.length) abyss = newAbyssReport
  else if (latestOldAbyssReport?.reports?.length) abyss = latestOldAbyssReport
  const abyssList = (abyss?.reports || [])
    .map(r => ({ key: String(r.updated_time_second || r.time_second || ""), data: r }))
    .filter(x => x.key)

  const battleList = (battleFieldReport?.reports || [])
    .map(r => ({ key: String(r.time_second || ""), data: r }))
    .filter(x => x.key)

  return { weekly, abyss: abyssList, battle: battleList }
}

/** 战报图片底部提示 */
export const REPORT_FOOTER = "发送#bh3深渊战报、#bh3战场战报和#bh3一周成绩单获取更多近期战报内容"

/** 舰长战报数据(一周成绩单 + 深渊战报 + 战场战报) */
export function buildReportCard(raw, { uid, server, nickname }) {
  const { index, weeklyReport, newAbyssReport, latestOldAbyssReport, battleFieldReport } = raw
  const role = index?.role || {}
  const week = weeklyReport || {}

  // 深渊战报: 超弦空间优先,否则旧深渊
  let abyss = null
  if (newAbyssReport?.reports?.length) abyss = newAbyssReport
  else if (latestOldAbyssReport?.reports?.length) abyss = latestOldAbyssReport
  const abyssReports = mapAbyssReports(abyss, 3)

  const bf = battleFieldReport?.reports?.[0]
  const bfInfo = bf
    ? {
        area: areaName(bf.area),
        pct: bf.ranking_percentage,
        score: bf.score,
        rank: bf.rank,
        time: fmtDate(bf.time_second),
      }
    : null
  const bfInfos = mapBattleFieldInfos(bf)

  return {
    uid,
    serverName: id2server(server),
    avatarUrl: role.AvatarUrl || "",
    nickname: role.nickname || nickname || "未知舰长",
    level: role.level || 0,
    // 一周成绩单
    weekly: mapWeekly(week),
    abyssReports,
    bfInfo,
    bfInfos,
    footer: REPORT_FOOTER,
  }
}

/** 深渊战报(更多近期记录, 合并本地历史) */
export function buildAbyssCard(raw, { uid, server, nickname }, history) {
  const { index, newAbyssReport, latestOldAbyssReport } = raw
  const role = index?.role || {}

  let abyss = null
  if (newAbyssReport?.reports?.length) abyss = newAbyssReport
  else if (latestOldAbyssReport?.reports?.length) abyss = latestOldAbyssReport

  const apiEntries = (abyss?.reports || [])
    .map(r => ({ key: String(r.updated_time_second || r.time_second || ""), data: r }))
    .filter(e => e.key)
  const merged = mergeEntries(apiEntries, history?.abyss || [], 10)

  return {
    uid,
    serverName: id2server(server),
    avatarUrl: role.AvatarUrl || "",
    nickname: role.nickname || nickname || "未知舰长",
    level: role.level || 0,
    abyssReports: mapAbyssReports({ reports: merged.map(e => e.data) }, 10),
    footer: REPORT_FOOTER,
  }
}

/** 战场战报(更多近期记录, 合并本地历史) */
export function buildBattleCard(raw, { uid, server, nickname }, history) {
  const { index, battleFieldReport } = raw
  const role = index?.role || {}

  const apiEntries = (battleFieldReport?.reports || [])
    .map(r => ({ key: String(r.time_second || ""), data: r }))
    .filter(e => e.key)
  const merged = mergeEntries(apiEntries, history?.battle || [], 10)

  return {
    uid,
    serverName: id2server(server),
    avatarUrl: role.AvatarUrl || "",
    nickname: role.nickname || nickname || "未知舰长",
    level: role.level || 0,
    bfReports: mapBattleFieldReports(merged.map(e => e.data), 10),
    footer: REPORT_FOOTER,
  }
}

/** 一周成绩单(当前 + 本地历史, 新的在前) */
export function buildWeeklyCard(raw, history, { uid, server, nickname }) {
  const role = raw?.index?.role || {}
  const weeks = (history?.weekly || []).slice(0, 10).map(x => {
    const w = mapWeekly(x.data)
    if (!w.start || !w.end) {
      const r = weekRange(x.key)
      w.start = r.start
      w.end = r.end
      w.range = r.start && r.end ? `${r.start} ~ ${r.end}` : r.start || ""
    }
    return { label: x.key, ...w }
  })

  return {
    uid,
    serverName: id2server(server),
    avatarUrl: role.AvatarUrl || "",
    nickname: role.nickname || nickname || "未知舰长",
    level: role.level || 0,
    weeks,
    footer: REPORT_FOOTER,
  }
}

/**
 * 计算女武神列表的列数与画布宽度
 * 目标: 图片 高:宽 尽量贴近 21:9 (竖版长图), 同时保证单卡宽度在合理区间
 */
function charaLayout(n) {
  const GAP = 12
  const PAD_H = 52
  const PAD_V = 54
  const HEADER_H = 170
  const GRID_MT = 16
  const CARD_H = 382
  const TARGET_W = 190
  const MIN_W = 160
  const MAX_W = 280
  /** 宽/高, 使 高:宽 ≈ 21:9 */
  const RATIO = 9 / 21

  if (n < 1) return { columns: 3, width: 720 }

  const heightOf = cols => {
    const rows = Math.ceil(n / cols)
    return PAD_V + HEADER_H + GRID_MT + rows * CARD_H + (rows - 1) * GAP
  }
  const naturalWidth = cols => PAD_H + cols * TARGET_W + (cols - 1) * GAP

  let cols = 1
  let best = Infinity
  for (let c = 1; c <= n; c++) {
    const diff = Math.abs(naturalWidth(c) / heightOf(c) - RATIO)
    if (diff < best) {
      best = diff
      cols = c
    }
  }

  const height = heightOf(cols)
  let width = Math.round(height * RATIO)
  let cardW = (width - PAD_H - (cols - 1) * GAP) / cols
  if (cardW < MIN_W || cardW > MAX_W) {
    cardW = Math.max(MIN_W, Math.min(MAX_W, cardW))
    width = PAD_H + Math.round(cols * cardW + (cols - 1) * GAP)
  }
  return { columns: cols, width }
}

/** 女武神列表数据 */
export function buildCharaCard(raw, { uid, server }) {
  const { index, characters } = raw
  const role = index?.role || {}
  const stats = index?.stats || {}

  const chars = (characters?.characters || []).map(c => {
    const a = c.character?.avatar || {}
    const w = c.character?.weapon || {}
    return {
      name: a.name || "未知",
      icon: a.half_length_icon_path || a.icon_path || "",
      bg: a.avatar_background_path || a.background_path || "",
      rank: rankName(a.star),
      rankClass: "rank-" + (Math.max(1, Math.min(5, a.star || 1))),
      level: a.level || 0,
      weapon: {
        name: w.name || "",
        icon: w.icon || "",
        rarity: w.rarity || 0,
        maxRarity: w.max_rarity || 0,
        stars: starStr(w.rarity, w.max_rarity),
      },
      stigmas: (c.character?.stigmatas || []).map(s => ({
        name: s.name || "",
        icon: s.icon || "",
        rarity: s.rarity || 0,
        maxRarity: s.max_rarity || 0,
        stars: starStr(s.rarity, s.max_rarity),
      })),
    }
  })

  return {
    uid,
    serverName: id2server(server),
    avatarUrl: role.AvatarUrl || "",
    nickname: role.nickname || "未知舰长",
    level: role.level || 0,
    armorNum: stats.armor_number || 0,
    sssNum: stats.sss_armor_number || 0,
    chars,
    ...charaLayout(chars.length),
  }
}

/** 补给记录条目 -> 展示数据(含星级) */
function parseGachaItem(item = []) {
  const time = (item.find(x => x.label === "补给时间") || {}).value || ""
  const content = (item.find(x => x.label === "补给内容") || {}).value || ""
  const m = content.match(/^\[(.+?)\](.*)$/)
  const type = m ? m[1] : "其他"
  let name = m ? m[2] : content
  if (type === "角色") name = name.replace(/角色卡$/, "")
  const star = gachaStar(type, name)
  const rank = type === "角色" ? NORM.characters[normName(name)] || "" : ""
  return { time, type, name, star, rank }
}

/** 道具记录条目 -> 展示数据(字段随类型不同: 角色/武器/圣痕/材料) */
function parseMaterialItem(item = [], groupLabel = "") {
  const pick = label => (item.find(x => x.label === label) || {}).value || ""
  const nameEntry = item.find(x => /名称$/.test(x.label))
  return {
    time: pick("时间"),
    kind: pick("类型") || groupLabel || "其他",
    op: pick("操作"),
    nameLabel: nameEntry ? nameEntry.label : "物品",
    name: nameEntry ? nameEntry.value : "",
  }
}

/** 按判定函数计算「出货」记录与距上次出货的抽数(自上次出货起计) */
function computeGold(records = [], isGold) {
  const oldestFirst = [...records].reverse()
  const out = []
  let n = 0
  for (const r of oldestFirst) {
    n++
    const p = parseGachaItem(r.item)
    if (isGold(p)) {
      out.push({ ...p, pity: n })
      n = 0
    }
  }
  return out.reverse()
}

/**
 * 计算某卡池的「出货」记录与抽数(自上次出货起计)
 * 角色/家园/庆典角色池: S级女武神; 装备/庆典装备池: 5⭐武器
 */
export function computePoolGold(records = [], poolLabel = "") {
  const isEquip = /装备/.test(poolLabel)
  return computeGold(records, p =>
    isEquip ? p.type === "武器" && p.star === 5 : p.type === "角色" && p.rank === "S",
  )
}

/** 补给记录 -> 「全部记录」风格按卡池分块的数据(仿原神 gacha-all-log) */
export function buildGachaCard({ groups = [], nickname, uid, serverName, avatarUrl }) {
  // 同名卡池(如 角色补给A/B)共享保底: 去掉末尾字母后合并记录(按 key 去重, 避免共享历史重复), 按时间倒序
  const byBase = new Map()
  for (const g of groups) {
    if (!g.records.length) continue
    const base = String(g.label).replace(/[A-Za-z]\s*$/, "")
    if (!byBase.has(base)) byBase.set(base, { records: new Map(), labels: [] })
    const entry = byBase.get(base)
    entry.labels.push(g.label)
    for (const r of g.records) {
      const k = r.key || JSON.stringify(r.item)
      if (!entry.records.has(k)) entry.records.set(k, r)
    }
  }
  const mergedGroups = [...byBase.entries()].map(([base, entry]) => {
    const records = [...entry.records.values()]
    records.sort((a, b) => String(b.item?.[0]?.value || "").localeCompare(String(a.item?.[0]?.value || "")))
    return { label: entry.labels.length > 1 ? base : entry.labels[0], records }
  })

  const pools = mergedGroups
    .filter(g => g.records.length)
    .map(g => {
      const pulls = g.records.length
      const isSynergyPool = /协同/.test(g.label)
      const isEquip = /装备/.test(g.label)
      const parsed = g.records.map(r => parseGachaItem(r.item))
      const count = fn => parsed.filter(fn).length
      let isGold, max, statItems
      if (isSynergyPool) {
        isGold = p => isSynergy(p.name)
        max = 100
        statItems = [{ num: count(p => isSynergy(p.name)), unit: "", lable: "S级协同者" }]
      } else if (isEquip) {
        isGold = p => p.type === "武器" && p.star === 5
        max = 50
        statItems = [
          { num: count(p => p.type === "武器" && p.star === 5), unit: "", lable: "5⭐武器" },
          { num: count(p => p.type === "圣痕" && p.star === 5), unit: "", lable: "5⭐圣痕" },
        ]
      } else {
        isGold = p => p.type === "角色" && p.rank === "S"
        max = 100
        statItems = [
          { num: count(p => p.type === "角色" && p.rank === "S"), unit: "", lable: "S级女武神" },
          { num: count(p => p.type === "角色" && p.rank === "A"), unit: "", lable: "A级女武神" },
        ]
      }
      const golds = computeGold(g.records, isGold)
      const avg = golds.length ? Math.round((pulls / golds.length) * 10) / 10 : 0
      const times = golds.map(x => x.time).filter(Boolean)
      const luckOf = n => (n <= 10 ? "gold" : n < max * 0.5 ? "good" : n < max * 0.83 ? "normal" : "bad")
      return {
        label: g.label,
        allNum: pulls,
        stats: [
          { num: pulls, unit: "抽", lable: "总抽数" },
          ...statItems,
          { num: avg, unit: "", lable: "平均出货" },
        ],
        firstTime: times[times.length - 1] || "",
        lastTime: times[0] || "",
        fiveLog: golds.map(x => ({ name: x.name, num: x.pity, luck: luckOf(x.pity), icon: gachaIcon(x.type, x.name) })),
      }
    })

  const cols = Math.min(3, Math.max(1, pools.length))
  const width = 30 + cols * 465 + (cols - 1) * 20

  return {
    nickname: nickname || "",
    uid,
    serverName: serverName || "",
    avatarUrl: avatarUrl || "",
    pools,
    total: pools.reduce((n, p) => n + p.allNum, 0),
    width,
  }
}

/** 帮助卡片数据 */
export function buildHelpCard() {
  return {
    groups: [
      {
        title: "角色 / 便签",
        items: [
          { cmd: "#崩坏3", desc: "角色卡片（使用绑定的 Cookie 账号）" },
          { cmd: "#崩坏3 <uid> <服务器>", desc: "查询指定角色，如 #崩坏3 100074751 官服" },
          { cmd: "#崩坏3 <米游社id> 米游社", desc: "通过米游社 id 查询" },
          { cmd: "#崩坏3角色", desc: "拥有的女武神列表" },
          { cmd: "#崩坏3体力", desc: "实时便签（体力 / 训练 / 深渊 / 战场 / 乐土）" },
        ],
      },
      {
        title: "战报 / 手账",
        items: [
          { cmd: "#崩坏3战报", desc: "舰长战报（一周成绩单 / 深渊战报 / 战场战报）" },
          { cmd: "#崩坏3深渊战报", desc: "更多近期深渊战报（含本地历史）" },
          { cmd: "#崩坏3战场战报", desc: "更多近期战场战报（含本地历史）" },
          { cmd: "#崩坏3一周成绩单", desc: "一周成绩单（含本地历史）" },
          { cmd: "#崩坏3手帐", desc: "水晶手账" },
        ],
      },
      {
        title: "补给 / 道具记录",
        items: [
          { cmd: "#崩坏3更新抽卡记录", desc: "更新并保存抽卡/补给记录（增量）" },
          { cmd: "#崩坏3更新道具记录", desc: "更新并保存道具记录（增量）" },
          { cmd: "#崩坏3抽卡记录", desc: "查看抽卡/补给记录" },
          { cmd: "#崩坏3抽卡记录角色", desc: "指定补给池（角色 / 装备 / 家园）" },
          { cmd: "#崩坏3抽卡统计", desc: "抽卡统计与高光（S 级 / 5 星）" },
          { cmd: "#崩坏3道具记录", desc: "查看道具记录" },
        ],
      },
    ],
    tips: [
      "上文 #崩坏3 开头均可替换为 #bh3",
      "记录类指令依赖逍遥插件保存的 stoken 自动获取查询凭据",
      "指令后 @他人 可查询对方的崩坏3账号，如 #崩坏3@小明",
      "未填写 uid 时自动使用绑定的 Cookie 账号（需先 #绑定Cookie）",
    ],
  }
}

/** 补给/道具记录 -> 渲染数据 */
export function buildRecordCard({ category, groups = [], nickname, uid, serverName, footer, avatarUrl, limit = 60, statOnly = false }) {
  const isGacha = category === "gacha"
  const parsedGroups = groups.map(g => ({
    label: g.label,
    count: g.records.length,
    shown: Math.min(g.records.length, limit),
    truncated: g.records.length > limit,
    records: g.records
      .slice(0, limit)
      .map(r => (isGacha ? parseGachaItem(r.item) : parseMaterialItem(r.item, g.label))),
  }))

  const summary = {}
  for (const g of parsedGroups) {
    for (const r of g.records) {
      const k = isGacha ? r.type : r.kind || "其他"
      summary[k] = (summary[k] || 0) + 1
    }
  }

  // 抽卡记录: 统计星级 + 各卡池出金抽数(S级角色 / 5星武器)
  let starList = []
  let poolGold = []
  if (isGacha) {
    const stars = { 5: 0, 4: 0, 3: 0 }
    for (const g of groups) {
      for (const r of g.records) {
        const p = parseGachaItem(r.item)
        stars[p.star] = (stars[p.star] || 0) + 1
      }
    }
    starList = [
      { star: 5, name: "S级/5星", count: stars[5] || 0, color: "#d64d94" },
      { star: 4, name: "A级/4星", count: stars[4] || 0, color: "#b23ac4" },
      { star: 3, name: "B级/3星", count: stars[3] || 0, color: "#8e35c9" },
    ]
    poolGold = groups.map(g => ({
      label: g.label,
      pulls: g.records.length,
      golds: computePoolGold(g.records, g.label),
    }))
  }

  const colors = {
    角色: "#d64d94",
    武器: "#b23ac4",
    圣痕: "#8e35c9",
    材料: "#f0a6e0",
    获得: "#c98ae8",
    消耗: "#ff7a7a",
  }
  const summaryList = Object.entries(summary).map(([name, count]) => ({
    name,
    count,
    color: colors[name] || "#a35fd0",
  }))

  return {
    category,
    isGacha,
    title: isGacha ? "补给记录" : "道具记录",
    nickname: nickname || "未知舰长",
    avatarUrl: avatarUrl || "",
    uid,
    serverName: serverName || "",
    groups: isGacha ? [] : parsedGroups,
    total: parsedGroups.reduce((n, g) => n + g.count, 0),
    summaryList,
    starList,
    poolGold,
    footer: footer || "",
  }
}
