import fs from 'node:fs'
import path from 'node:path'

/**
 * 原子写 JSON：先写同目录临时文件再 rename。
 * 进程被 kill / 断电时，原文件要么是旧的完整内容，要么是新的完整内容，
 * 不会出现「写了一半的 JSON」导致下次读取直接抛错、数据全丢。
 * @param {string} file 目标文件
 * @param {unknown} data 可序列化数据
 * @param {{mode?: number, pretty?: boolean}} [options]
 */
export function writeJsonAtomic(file, data, options = {}) {
  const { mode = 0o600, pretty = true } = options
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0), { encoding: 'utf8', mode })
    fs.renameSync(tmp, file)
    if (mode) {
      try {
        fs.chmodSync(file, mode)
      } catch {
        /* Windows 上 chmod 可能无效，忽略 */
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 读 JSON，失败返回兜底值（不存在 / 内容损坏都走兜底）
 * @param {string} file
 * @param {unknown} [fallback]
 */
export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
