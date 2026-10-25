import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { cleanOldFiles, screenshotHtml } from './browser.js'
import { getAllCharacters } from './characters.js'

const OUT_DIR = path.join(process.cwd(), 'data', 'bh3')
/** 帮助图缓存保留 7 天；至少保留最近 3 份，避免角色图更新后旧图被立刻删掉 */
const HELP_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getElysiaArt() {
  const list = getAllCharacters()
  const preferred = list.find(character => character.name === '粉色妖精小姐♪')
  const fallback = list.find(character =>
    (character.aliases || []).some(alias => alias.includes('爱莉希雅'))
  )
  const target = preferred || fallback
  if (!target) return { background: '', portrait: '' }
  return {
    background: target.background || '',
    portrait: target.portrait || '',
  }
}

function commandRows(items) {
  return items
    .map(item => {
      const [command, description] = item
      return `
        <div class="cmd-row">
          <code>${escapeHtml(command)}</code>
          <span>${escapeHtml(description)}</span>
        </div>`
    })
    .join('')
}

function buildHelpHtml(art = {}) {
  const portrait = art.portrait
    ? `<div class="art"><img src="${escapeHtml(art.portrait)}" alt="爱莉希雅"></div>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { overflow-x: hidden; }
  body {
    width: 900px;
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    color: #fff;
    background:
      radial-gradient(900px 480px at 82% -8%, rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0) 62%),
      radial-gradient(640px 420px at 12% 6%, rgba(255, 214, 232, 0.95), rgba(255, 214, 232, 0) 68%),
      radial-gradient(760px 520px at 78% 52%, rgba(232, 178, 244, 0.75), rgba(232, 178, 244, 0) 66%),
      radial-gradient(680px 520px at 20% 78%, rgba(208, 168, 244, 0.7), rgba(208, 168, 244, 0) 64%),
      linear-gradient(180deg, #fbd8f0 0%, #eecdf4 38%, #d3b4f0 72%, #bda0ea 100%);
    position: relative;
    overflow-x: visible;
    padding: 36px 44px 30px;
  }
  .sky {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(520px 260px at 30% 14%, rgba(255, 244, 250, 0.9), rgba(255, 244, 250, 0) 70%),
      radial-gradient(420px 220px at 66% 30%, rgba(255, 228, 240, 0.65), rgba(255, 228, 240, 0) 72%);
    pointer-events: none;
  }
  .content { position: relative; z-index: 2; }
  .art {
    position: absolute;
    right: 0;
    top: -34px;
    width: 330px;
    height: 470px;
    overflow: hidden;
    z-index: 1;
    pointer-events: none;
    -webkit-mask-image: linear-gradient(to bottom, #000 42%, rgba(0, 0, 0, 0.55) 62%, transparent 88%);
    mask-image: linear-gradient(to bottom, #000 42%, rgba(0, 0, 0, 0.55) 62%, transparent 88%);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
    filter: drop-shadow(0 6px 24px rgba(190, 90, 150, 0.45)) saturate(1.06);
  }
  .header { display: flex; flex-direction: column; }
  .title {
    font-size: 46px;
    font-weight: 800;
    letter-spacing: 2px;
    background: linear-gradient(92deg, #d63a8c 8%, #b23ac4 45%, #8e35c9 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 2px 5px rgba(255, 255, 255, 0.95))
            drop-shadow(0 4px 14px rgba(214, 77, 148, 0.45));
  }
  .subtitle {
    margin-top: 10px;
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 3.5px;
    color: #7a4a9e;
  }
  .divider {
    margin: 22px 0 20px;
    height: 2px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.95), rgba(255, 180, 215, 0.55), rgba(200, 150, 235, 0.2), transparent);
    border-radius: 3px;
    box-shadow: 0 0 14px rgba(255, 190, 220, 0.5);
  }
  .section {
    margin-top: 20px;
    background: linear-gradient(150deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.18));
    border: 1px solid rgba(255, 214, 232, 0.65);
    border-radius: 22px;
    padding: 18px 24px 14px;
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    box-shadow:
      0 10px 36px rgba(160, 80, 160, 0.22),
      inset 0 1px 0 rgba(255, 255, 255, 0.55);
  }
  .section-title {
    font-size: 21px;
    font-weight: 800;
    margin-bottom: 10px;
    padding-left: 13px;
    border-left: 4px solid #d64d94;
    border-radius: 2px;
    color: #8e2f68;
    letter-spacing: 1px;
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.8);
  }
  .cmd-row {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding: 6.5px 2px;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.35);
    font-size: 15px;
  }
  .cmd-row:last-child { border-bottom: none; }
  .cmd-row code {
    flex: 0 0 278px;
    font-family: "SF Mono", Consolas, monospace;
    font-size: 13.5px;
    font-weight: 600;
    color: #6d2358;
    background: rgba(255, 255, 255, 0.88);
    border-radius: 9px;
    padding: 3.5px 11px;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(160, 70, 140, 0.18);
  }
  .cmd-row span { color: #57204a; }
  .example {
    margin-top: 18px;
    font-size: 13.5px;
    color: #57204a;
    line-height: 1.8;
    text-align: center;
    background: rgba(255, 255, 255, 0.62);
    border-radius: 14px;
    padding: 9px 16px;
    border: 1px solid rgba(214, 77, 148, 0.45);
  }
</style>
</head>
<body>
  <div class="sky"></div>
  ${portrait}
  <div class="content">
    <div class="header">
      <div class="title">【崩坏3 查询助手】</div>
      <div class="subtitle">HONKAI IMPACT 3RD · QUERY PLUGIN</div>
    </div>
    <div class="divider"></div>

    <div class="section">
      <div class="section-title">战绩查询</div>
      ${commandRows([
        ['#崩坏3面板 [UID]', '总览：等级 / 收藏 / 深渊 / 战场'],
        ['#崩坏3体力 [UID]', '实时便签（体力/训练/深渊/战场/乐土）'],
        ['#崩坏3角色', '拥有的女武神列表（Cookie 账号）'],
        ['#崩坏3角色 <角色名>', '指定角色面板（头像/装备/六维）'],
        ['#崩坏3深渊 [UID]', '超弦空间 + 量子奇点'],
        ['#崩坏3战场 [UID]', '记忆战场战绩'],
        ['#崩坏3逐光 [UID]', '往世乐土战绩'],
        ['#崩坏3cookie <Cookie>', '主人配置公共 Cookie（群友免绑）'],
      ])}
    </div>

    <div class="section">
      <div class="section-title">玩家卡片 · 战报</div>
      ${commandRows([
        ['#崩坏3 [uid]', '玩家卡片（服务器可省略，自动识别）'],
        ['#崩坏3战报', '舰长战报（成绩单 / 深渊 / 战场）'],
        ['#崩坏3深渊战报', '更多深渊战报（含本地历史）'],
        ['#崩坏3战场战报', '更多战场战报（含本地历史）'],
        ['#崩坏3一周成绩单', '一周成绩单（含本地历史）'],
        ['#崩坏3手帐', '水晶手账（需绑定 Cookie）'],
      ])}
    </div>

    <div class="section">
      <div class="section-title">补给 · 道具记录</div>
      ${commandRows([
        ['#崩坏3更新抽卡记录', '更新并保存补给记录（增量）'],
        ['#崩坏3抽卡记录', '查看补给记录 / 出货抽数'],
        ['#崩坏3抽卡统计', '抽卡统计（S 级 / 5 星）'],
        ['#崩坏3更新道具记录', '更新并保存道具记录（增量）'],
        ['#崩坏3道具记录', '查看道具记录'],
      ])}
    </div>

    <div class="section">
      <div class="section-title">角色数据</div>
      ${commandRows([
        ['#崩坏3角色图 <名字/别名>', '角色立绘 + 背景图 + 档案'],
        ['#崩坏3伤害 <角色> <攻击>', '伤害估算（倍率/增伤/暴击可调）'],
        ['#崩坏3角色列表', `${getAllCharacters().length} 名女武神清单`],
        ['#崩坏3更新角色库', '主人手动刷新数据库（启动时自动）'],
      ])}
    </div>

    <div class="section">
      <div class="section-title">图鉴查询</div>
      ${commandRows([
        ['#崩坏3图鉴 <关键词>', '搜索图鉴（支持别名）'],
        ['#崩坏3角色图鉴 <名字>', '角色图鉴'],
        ['#崩坏3武器图鉴 <名字>', '武器图鉴'],
        ['#崩坏3圣痕图鉴 <名字>', '圣痕图鉴'],
        ['#崩坏3图鉴详情 <编号>', '查看指定条目'],
      ])}
    </div>

    <div class="example">
      示例：#崩坏3伤害 炎律 1400 300 20 100 200　·　#崩坏3角色图 爱莉希雅　·　#崩坏3面板 100000001
    </div>
  </div>
</body>
</html>`
}

export async function renderHelpImage() {
  const html = buildHelpHtml(getElysiaArt())
  // 帮助图内容完全由 HTML 决定：用内容哈希做缓存键，内容不变就不再启动浏览器
  const hash = crypto.createHash('md5').update(html).digest('hex').slice(0, 12)
  const outputPath = path.join(OUT_DIR, `help-${hash}.jpg`)

  try {
    const stat = fs.statSync(outputPath)
    if (stat.size > 1024) return outputPath
  } catch {
    /* 缓存未命中 */
  }

  try {
    // JPEG + 1.5 倍率：文字仍然清晰，体积约为原来 PNG 的 1/5，QQ 发送更快更稳
    await screenshotHtml(html, {
      width: 900,
      deviceScaleFactor: 1.5,
      outputPath,
      quality: 88,
      waitImages: 4500,
    })
    // 删除旧的 help.png / help-*.png 缓存与过期图片，最多保留最近 3 份
    try {
      for (const file of fs.readdirSync(OUT_DIR)) {
        if (file === 'help.png' || /^help-[0-9a-f]+\.png$/.test(file)) {
          fs.unlinkSync(path.join(OUT_DIR, file))
        }
      }
    } catch {
      /* ignore */
    }
    cleanOldFiles(OUT_DIR, {
      prefix: 'help-',
      suffix: '.jpg',
      maxAgeMs: HELP_CACHE_MAX_AGE_MS,
      keep: 3,
    })
    return outputPath
  } catch (error) {
    globalThis.logger?.warn?.(`[bh3] 帮助图渲染失败，已回退纯文本: ${error.message}`)
    return null
  }
}

export { buildHelpHtml }
