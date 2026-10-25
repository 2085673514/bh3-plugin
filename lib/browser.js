import fs from 'node:fs'
import path from 'node:path'

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

let browserPromise = null

/** 获取共享浏览器实例（失败时清空单例，便于下次重试） */
export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const mod = await import('puppeteer')
      const puppeteer = mod.default ?? mod
      return puppeteer.launch({ headless: true, args: LAUNCH_ARGS })
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

/** 关闭共享浏览器（仅在插件卸载/测试时使用） */
export async function closeBrowser() {
  const pending = browserPromise
  browserPromise = null
  try {
    const browser = await pending
    await browser?.close?.()
  } catch {
    /* ignore */
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
  } = options

  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
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
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * 清理目录里的过期临时图（按前缀/后缀过滤）。
 * @param {string} dir
 * @param {object} [options]
 * @param {string} [options.prefix] 文件名前缀
 * @param {string} [options.suffix] 文件名后缀
 * @param {number} [options.maxAgeMs] 最大保留时长
 * @param {number} [options.keep] 额外保留最新的 N 个（按修改时间）
 */
export function cleanOldFiles(dir, options = {}) {
  const { prefix = '', suffix = '.png', maxAgeMs = 7 * 24 * 60 * 60 * 1000, keep = 0 } = options
  try {
    const files = fs.readdirSync(dir)
      .filter(file => file.startsWith(prefix) && file.endsWith(suffix))
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
