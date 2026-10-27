/**
 * 出图参数配置。
 * 默认值保持不变，通过环境变量可以在不修改代码的情况下统一调清晰度/体积/等图时间：
 *   BH3_IMAGE_SCALE=1.25        渲染倍率乘数（默认 1，越大越清晰、体积越大）
 *   BH3_IMAGE_QUALITY=75        JPEG 质量上限（默认不限制，只降不升）
 *   BH3_IMAGE_WAIT_MS=6000      等图时间默认值（调用方未指定时生效）
 *   BH3_IMAGE_MAX_BYTES=1500000 单图体积上限，超出自动降质重截
 *   BH3_IMAGE_SAVER=1           省流模式：倍率 ×0.8、质量上限 75、体积上限 1.2MB
 */

const numberOr = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const flagOn = value => /^(1|true|on|yes)$/i.test(String(value ?? '').trim())

const saver = flagOn(process.env.BH3_IMAGE_SAVER)
const scaleEnv = numberOr(process.env.BH3_IMAGE_SCALE, 1)
const qualityEnv = numberOr(process.env.BH3_IMAGE_QUALITY, 0)
const waitEnv = numberOr(process.env.BH3_IMAGE_WAIT_MS, 0)

export const IMAGE_CONFIG = {
  /** 倍率乘数：作用在所有 deviceScaleFactor 上 */
  scale: Number((scaleEnv * (saver ? 0.8 : 1)).toFixed(2)),
  /** JPEG 质量上限；0 表示不覆盖调用方的值 */
  quality: qualityEnv ? Math.min(qualityEnv, 100) : (saver ? 75 : 0),
  /** 等图时间默认值；0 表示只用调用方的值 */
  waitImages: waitEnv,
  /** 单图体积上限 */
  maxBytes: Math.round(numberOr(process.env.BH3_IMAGE_MAX_BYTES, 2 * 1024 * 1024) * (saver ? 0.6 : 1)),
  saver,
}

/** 把环境变量配置套到一次渲染参数上；显式参数仍可覆盖（质量/等图只能被限制得更省） */
export function applyImageOptions(options = {}) {
  const next = { ...options }
  if (next.deviceScaleFactor) {
    next.deviceScaleFactor = Number((Number(next.deviceScaleFactor) * IMAGE_CONFIG.scale).toFixed(2))
  }
  if (IMAGE_CONFIG.quality) {
    const quality = Number(next.quality) || IMAGE_CONFIG.quality
    next.quality = Math.min(quality, IMAGE_CONFIG.quality)
  }
  if (!next.waitImages && IMAGE_CONFIG.waitImages) {
    next.waitImages = IMAGE_CONFIG.waitImages
  }
  if (!next.maxBytes) {
    next.maxBytes = IMAGE_CONFIG.maxBytes
  }
  return next
}

/** 用于帮助信息/日志的一行描述 */
export function describeImageConfig() {
  return `倍率 ×${IMAGE_CONFIG.scale}、质量上限 ${IMAGE_CONFIG.quality || '默认'}、等图 ${IMAGE_CONFIG.waitImages || '按调用方'}ms、单图上限 ${(IMAGE_CONFIG.maxBytes / 1024).toFixed(0)}KB${IMAGE_CONFIG.saver ? '（省流模式）' : ''}`
}
