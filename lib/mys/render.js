import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTML_DIR = path.join(__dirname, '..', '..', 'resources', 'html')
const OUT_DIR = path.join(process.cwd(), 'data', 'bh3')
const CRYSTELF_RENDERER_URL = fileURLToPath(
  new URL('../../../crystelf-plugin/lib/system/puppeteerRenderer.js', import.meta.url),
)

/** 高分辨率渲染倍率(相对 CSS 像素) */
export const DEVICE_SCALE = 2.5

let counter = 0

function cleanOld() {
  try {
    const cutoff = Date.now() - 15 * 60 * 1000
    for (const file of fs.readdirSync(OUT_DIR)) {
      if (!file.startsWith('mys-') || !file.endsWith('.png')) continue
      const filePath = path.join(OUT_DIR, file)
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath)
    }
  } catch {
    /* ignore */
  }
}

/**
 * 等待页面图片加载，但最多等待 timeoutMs，避免远程图片卡死导致整体超时
 */
async function waitImagesBound(page, timeoutMs = 8000) {
  const imageWait = page
    .evaluate(() =>
      Promise.all(
        Array.from(document.images).map(img =>
          img.complete ? Promise.resolve() : new Promise(resolve => {
            img.onload = resolve
            img.onerror = resolve
          }),
        ),
      ),
    )
    .catch(() => {})
  await Promise.race([imageWait, new Promise(resolve => setTimeout(resolve, timeoutMs))])
}

async function shootWithPuppeteer(html, outputPath) {
  const puppeteer = await import('puppeteer')
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-zygote'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: DEVICE_SCALE })
    // 用 domcontentloaded 快速返回，再对图片做有界等待，避免 networkidle2 长时间卡住
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitImagesBound(page, 6000)
    await new Promise(resolve => setTimeout(resolve, 150))
    const el = (await page.$('#container')) || (await page.$('body'))
    const box = el ? await el.boundingBox() : null
    if (box && box.width && box.height) {
      await page.setViewport({
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
        deviceScaleFactor: DEVICE_SCALE,
      })
    }
    const buffer = await (el || page).screenshot({ type: 'png' })
    fs.writeFileSync(outputPath, buffer)
    return outputPath
  } finally {
    await browser.close().catch(() => {})
  }
}

async function shootWithShared(html, outputPath) {
  const { renderHtmlToImage } = await import(CRYSTELF_RENDERER_URL)
  await renderHtmlToImage({
    html,
    outputPath,
    viewport: { width: 1000, height: 700, deviceScaleFactor: DEVICE_SCALE },
    contentOptions: { waitUntil: 'domcontentloaded' },
    afterContent: page => waitImagesBound(page, 6000),
  })
  return outputPath
}

/**
 * 用 art-template 渲染 honkai-mys 模板，并以高分辨率截图
 * @param {string} name resources/html 下的模板名(不含 .html)
 * @param {object} data 模板数据
 * @returns {Promise<string>} 生成的图片路径
 */
export async function renderMysTemplate(name, data = {}) {
  const tplFile = path.join(HTML_DIR, `${name}.html`)
  const raw = fs.readFileSync(tplFile, 'utf8')
  const artTemplate = (await import('art-template')).default
  const html = artTemplate.render(raw, data)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  cleanOld()
  const outputPath = path.join(OUT_DIR, `mys-${Date.now()}-${counter++ % 100}.png`)

  try {
    return await shootWithShared(html, outputPath)
  } catch {
    return shootWithPuppeteer(html, outputPath)
  }
}
