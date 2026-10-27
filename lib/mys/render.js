import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanOldFiles, withPage, waitImagesBound } from '../browser.js'
import { applyImageOptions, IMAGE_CONFIG } from '../imageConfig.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTML_DIR = path.join(__dirname, '..', '..', 'resources', 'html')
const OUT_DIR = path.join(process.cwd(), 'data', 'bh3')

/** 渲染倍率(相对 CSS 像素)：2 倍已足够清晰，再高只会让体积和发送耗时翻倍 */
export const DEVICE_SCALE = Number((2 * IMAGE_CONFIG.scale).toFixed(2))

/** 临时图保留时长；过期清理每 60 秒最多做一次，避免每次出图都扫目录 */
const OUT_TTL_MS = 15 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 1000
let lastCleanup = 0

let counter = 0

/** art-template 动态 import 只做一次 */
let artTemplatePromise = null
function loadArtTemplate() {
  if (!artTemplatePromise) {
    artTemplatePromise = import('art-template')
      .then(mod => mod.default ?? mod)
      .catch(error => {
        artTemplatePromise = null
        throw error
      })
  }
  return artTemplatePromise
}

/** 模板编译缓存：art-template.render(source) 每次都会重新编译，编译结果按 mtime 缓存 */
const templateCache = new Map()

async function compileTemplate(name) {
  const tplFile = path.join(HTML_DIR, `${name}.html`)
  const { mtimeMs } = fs.statSync(tplFile)
  const cached = templateCache.get(tplFile)
  if (cached && cached.mtimeMs === mtimeMs) return cached.render
  const source = fs.readFileSync(tplFile, 'utf8')
  const artTemplate = await loadArtTemplate()
  const render = typeof artTemplate.compile === 'function'
    ? artTemplate.compile(source)
    : data => artTemplate.render(source, data)
  templateCache.set(tplFile, { mtimeMs, render })
  return render
}

function cleanupOutput() {
  const now = Date.now()
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  // 一次扫描同时清理 .jpg 与旧版本遗留的 .png
  cleanOldFiles(OUT_DIR, { prefix: 'mys-', suffix: ['.jpg', '.png'], maxAgeMs: OUT_TTL_MS })
}

/** 用共享浏览器截图；不再每次 launch/close，失败由调用方回退框架渲染 */
async function shoot(html, outputPath, options = {}) {
  const {
    deviceScaleFactor,
    quality,
    waitImages,
    maxBytes,
  } = applyImageOptions({ deviceScaleFactor: DEVICE_SCALE, quality: 85, waitImages: 4500, ...options })
  return withPage(async page => {
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor })
    // 用 domcontentloaded 快速返回，再对图片做有界等待，避免 networkidle2 长时间卡住
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitImagesBound(page, waitImages)
    await new Promise(resolve => setTimeout(resolve, 150))
    const el = (await page.$('#container')) || (await page.$('body'))
    const box = el ? await el.boundingBox() : null
    if (box && box.width && box.height) {
      await page.setViewport({
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
        deviceScaleFactor,
      })
    }
    // JPEG 输出：长图体积通常只有 PNG 的 1/5，QQ 发送不易失败
    let buffer = await (el || page).screenshot({ type: 'jpeg', quality })
    if (buffer.length > maxBytes && quality > 60) {
      buffer = await (el || page).screenshot({ type: 'jpeg', quality: 60 })
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, buffer)
    return outputPath
  })
}

/** 同一类渲染错误只提醒一次，避免刷屏 */
const warnedErrors = new Set()

/**
 * 用 art-template 渲染 honkai-mys 模板，并以高分辨率截图
 * @param {string} name resources/html 下的模板名(不含 .html)
 * @param {object} data 模板数据
 * @param {{deviceScaleFactor?: number, quality?: number, waitImages?: number}} options 渲染参数
 * @returns {Promise<string>} 生成的图片路径
 */
export async function renderMysTemplate(name, data = {}, options = {}) {
  const render = await compileTemplate(name)
  const html = render(data)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  cleanupOutput()
  const outputPath = path.join(OUT_DIR, `mys-${Date.now()}-${counter++ % 100}.jpg`)

  try {
    return await shoot(html, outputPath, options)
  } catch (error) {
    // 不再静默吞掉异常：上层会回退到框架 renderImg，同类错误只 warn 一次
    const message = String(error?.message || error)
    if (!warnedErrors.has(message)) {
      warnedErrors.add(message)
      globalThis.logger?.warn?.(`[bh3] 高分辨率渲染失败: ${message}`)
    }
    throw error
  }
}
