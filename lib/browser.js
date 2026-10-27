import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyImageOptions } from './imageConfig.js'

/**
 * 全插件共享的 Chromium 实例。
 * 原先 cardImage / helpImage / mys-render 各自 launch 一次浏览器，出图耗时 2~14s；
 * 这里改为进程内单例：首次出图启动，之后复用，断开后自动重建。
 */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
]

/** 同时打开的页面数上限：每次出图一个页面，页面越多 Chromium 内存涨得越快 */
const MAX_PAGES = Math.max(1, Number(process.env.BH3_MAX_RENDER_PAGES) || 3)
let activePages = 0
const pageWaiters = []

function acquirePageSlot() {
  if (activePages < MAX_PAGES) {
    activePages += 1
    return Promise.resolve()
  }
  return new Promise(resolve => pageWaiters.push(resolve))
}

function releasePageSlot() {
  const next = pageWaiters.shift()
  // 有排队者时把名额直接转交，不必先减再加
  if (next) next()
  else activePages -= 1
}

let browserPromise = null

/**
 * 候选 Chrome 路径。
 * puppeteer 22 固定查找 Chrome 127，本机只装了其它版本时会直接报
 * 「Could not find Chrome (ver. 127.0.6533.88)」，于是依次退到：
 *   环境变量 → puppeteer 缓存里的新版本 → 系统 Chrome/Edge。
 * 注意：缓存里 `win64-1095492` 这种纯构建号目录是 Chrome 111 左右的老布局，
 * 配新 puppeteer 启动会卡死，因此带版本号的目录优先。
 */
function findExecutable(env = process.env, homedir = os.homedir()) {
  const fromEnv = env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const candidates = cachedChromePaths(path.join(homedir, '.cache', 'puppeteer', 'chrome'))
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    )
  }
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  )

  return candidates.find(file => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  })
}

/** 列出 puppeteer 缓存里的 chrome 可执行文件，新版本在前 */
function cachedChromePaths(cacheRoot) {
  const subPaths = process.platform === 'darwin'
    ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
       'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
    : ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome']

  let entries = []
  try {
    entries = fs.readdirSync(cacheRoot).map(dir => ({
      dir,
      // win64-131.0.6778.85 → 131.0.6778.85；win64-1095492 → 老布局，没有版本号
      version: /^\d+\.\d+\.\d+/.test(dir.replace(/^[^-]+-/, '')) ? dir.replace(/^[^-]+-/, '') : null,
    }))
  } catch {
    return []
  }

  entries.sort((a, b) => {
    if (a.version && b.version) return compareVersion(b.version, a.version)
    if (a.version) return -1
    if (b.version) return 1
    return Number(b.dir.replace(/^[^-]+-/, '')) - Number(a.dir.replace(/^[^-]+-/, ''))
  })

  return entries.flatMap(entry => subPaths.map(sub => path.join(cacheRoot, entry.dir, sub)))
}

/** 版本号比较（130.0.1 > 99.0.2） */
function compareVersion(a = '', b = '') {
  const pa = String(a).split(/[.-]/).map(Number)
  const pb = String(b).split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff) return diff
  }
  return 0
}

/** 获取共享浏览器实例（失败时清空单例，便于下次重试） */
export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let puppeteer
      try {
        const mod = await import('puppeteer')
        puppeteer = mod.default ?? mod
      } catch (error) {
        throw new Error(`未安装 puppeteer，无法生成图片（可在插件目录执行 npm i puppeteer）：${error.message}`)
      }
      const executablePath = findExecutable()
      return puppeteer.launch({
        headless: true,
        args: LAUNCH_ARGS,
        ...(executablePath ? { executablePath } : {}),
      })
    })().catch(error => {
      browserPromise = null
      throw error
    })
    const browser = await browserPromise
    browser.on('disconnected', () => {
      browserPromise = null
    })
  }
  return browserPromise
}

/**
 * 借一个页面执行 fn，结束时必定关闭页面并归还名额。
 * 超过 MAX_PAGES 时排队等待，避免瞬时刷屏把 Chromium 内存打爆。
 * @template T
 * @param {(page: import('puppeteer').Page) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPage(fn) {
  await acquirePageSlot()
  let page = null
  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    return await fn(page)
  } finally {
    try {
      await page?.close?.()
    } catch {
      /* 页面可能已被浏览器断开时回收 */
    }
    releasePageSlot()
  }
}

/** 等待页面图片加载完成，最多等待 timeoutMs，避免远程图片挂起导致无限等待 */
export async function waitImagesBound(page, timeoutMs = 6000) {
  const imageWait = page
    .evaluate(() =>
      Promise.all(
        Array.from(document.images).map(img =>
          img.complete
            ? Promise.resolve()
            : new Promise(resolve => {
                img.onload = resolve
                img.onerror = resolve
              }),
        ),
      ),
    )
    .catch(() => {})
  await Promise.race([imageWait, new Promise(resolve => setTimeout(resolve, timeoutMs))])
}

/**
 * 用共享浏览器渲染一段 HTML 并截图。
 * 默认输出 JPEG：同样的内容体积通常只有 PNG 的 1/4~1/5，QQ 发送不容易超限。
 * @param {string} html
 * @param {object} options
 * @param {number} [options.width] 视口宽度
 * @param {number} [options.deviceScaleFactor] 清晰度倍率
 * @param {string} [options.outputPath] 输出文件路径；不传则返回 Buffer
 * @param {number} [options.waitImages] 等图上限(ms)
 * @param {boolean} [options.fullPage] 是否整页截图
 * @param {'jpeg'|'png'} [options.type] 输出格式，默认 jpeg
 * @param {number} [options.quality] JPEG 质量，默认 85
 * @param {number} [options.maxBytes] 超过该体积时自动降质量重截一次
 * @param {(page: import('puppeteer').Page) => Promise<void>} [options.afterContent]
 * @returns {Promise<string|Buffer>}
 */
export async function screenshotHtml(html, options = {}) {
  const {
    width = 900,
    height = 600,
    deviceScaleFactor = 2,
    outputPath = '',
    waitImages = 4500,
    fullPage = true,
    type = 'jpeg',
    quality = 85,
    maxBytes = 2 * 1024 * 1024,
    afterContent,
  } = applyImageOptions(options)

  return withPage(async page => {
    await page.setViewport({ width, height, deviceScaleFactor })
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitImagesBound(page, waitImages)
    if (typeof afterContent === 'function') await afterContent(page)
    const contentHeight = await page.evaluate(() => {
      const bodyHeight = Math.ceil(document.body.getBoundingClientRect().height)
      const scrollHeight = Math.ceil(document.documentElement.scrollHeight)
      const total = Math.max(bodyHeight, scrollHeight)
      document.documentElement.style.height = `${total}px`
      document.body.style.height = `${total}px`
      return total
    })
    await page.setViewport({
      width,
      height: Math.max(1, Math.ceil(contentHeight)),
      deviceScaleFactor,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    const shoot = q =>
      page.screenshot({
        type,
        fullPage,
        ...(type === 'jpeg' ? { quality: q } : {}),
      })
    let buffer = await shoot(quality)
    // 极端长图仍可能偏大：降一档质量再截一次，仍超限则原样返回（至少比 PNG 小）
    if (type === 'jpeg' && buffer.length > maxBytes && quality > 60) {
      buffer = await shoot(60)
    }
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, buffer)
      return outputPath
    }
    return buffer
  })
}

/**
 * 清理目录里的过期临时图（按前缀/后缀过滤）。
 * @param {string} dir
 * @param {object} [options]
 * @param {string} [options.prefix] 文件名前缀
 * @param {string|string[]} [options.suffix] 文件名后缀，可传多个（一次扫描搞定）
 * @param {number} [options.maxAgeMs] 最大保留时长
 * @param {number} [options.keep] 额外保留最新的 N 个（按修改时间）
 */
export function cleanOldFiles(dir, options = {}) {
  const { prefix = '', suffix = '.png', maxAgeMs = 7 * 24 * 60 * 60 * 1000, keep = 0 } = options
  const suffixes = Array.isArray(suffix) ? suffix : [suffix]
  try {
    const files = fs.readdirSync(dir)
      .filter(file => file.startsWith(prefix) && suffixes.some(ext => file.endsWith(ext)))
      .map(file => {
        const filePath = path.join(dir, file)
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const cutoff = Date.now() - maxAgeMs
    files.forEach((item, index) => {
      if (index < keep) return
      if (item.mtimeMs < cutoff) fs.unlinkSync(item.filePath)
    })
  } catch {
    /* 清理失败不影响渲染 */
  }
}
