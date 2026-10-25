/** 网络请求小工具：超时 + 一次重试（429/5xx/网络错误） */

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * fetch 包装：遇到 429、5xx 或网络错误时退避重试一次。
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {{retries?:number, timeoutMs?:number, retryDelayMs?:number}} [config]
 */
export async function fetchWithRetry(url, options = {}, config = {}) {
  const { retries = 1, timeoutMs = 15000, retryDelayMs = 600 } = config
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const { signal, ...rest } = options
      const res = await fetch(url, {
        ...rest,
        signal: signal || AbortSignal.timeout(timeoutMs),
      })
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        let delay = retryDelayMs * (attempt + 1)
        const retryAfter = Number(res.headers?.get?.('retry-after'))
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          delay = Math.min(3000, retryAfter * 1000)
        }
        await sleep(delay)
        continue
      }
      return res
    } catch (error) {
      lastError = error
      if (attempt >= retries) throw error
      await sleep(retryDelayMs * (attempt + 1))
    }
  }
  throw lastError
}
