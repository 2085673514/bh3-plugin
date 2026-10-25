import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanOldFiles, getBrowser, waitImagesBound } from '../browser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTML_DIR = path.join(__dirname, '..', '..', 'resources', 'html')
const OUT_DIR = path.join(process.cwd(), 'data', 'bh3')

/** 高分辨率渲染倍率(相对 CSS 像素) */
export const DEVICE_SCALE = 2.5

let counter = 0

/** 用共享浏览器截图；不再每次 launch/close，失败由调用方回退框架渲染 */
async function shoot(html, outputPath) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
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
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, buffer)
    return outputPath
  } finally {
    await page.close().catch(() => {})
  }
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
  cleanOldFiles(OUT_DIR, { prefix: 'mys-', maxAgeMs: 15 * 60 * 1000 })
  const outputPath = path.join(OUT_DIR, `mys-${Date.now()}-${counter++ % 100}.png`)

  try {
    return await shoot(html, outputPath)
  } catch (error) {
    // 不再静默吞掉异常：上层会回退到框架 renderImg，并打印一条 warn
    globalThis.logger?.warn?.(`[bh3] 高分辨率渲染失败: ${error.message}`)
    throw error
  }
}
