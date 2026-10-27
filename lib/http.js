/**
 * 网络请求小工具：
 * - 同一域名串行发送 + 最小间隔，避免瞬间并发被米游社限流（retcode 500「请求过于频繁」）
 * - 遇到 429 / 5xx / 网络错误退避重试
 * - 响应体里出现限流文案时再退避重试
 */

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 同域名请求队列的尾部 Promise */
const hostChains = new Map()

/** 同域名两次请求之间的最小间隔（毫秒），可用环境变量覆盖 */
const HOST_GAP_MS = Math.max(0, Number(process.env.BH3_HTTP_GAP_MS) || 250)

const RATE_LIMIT_HINT = /频繁|too\s*many|rate\s*limit/i

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

/**
 * 把任务排到该域名队列的末尾，前一个请求结束后再等一个间隔才开始
 */
function enqueue(host, task) {
  const prev = hostChains.get(host) || Promise.resolve()
  const current = prev.then(async () => {
    await sleep(HOST_GAP_MS)
    return task()
  })
  // 队列本身不允许被拒绝，否则后续请求全部被带崩
  hostChains.set(
    host,
    current.then(
      () => undefined,
      () => undefined,
    ),
  )
  return current
}

/**
 * 判断响应是否是「服务端限流」：HTTP 429，或 JSON 里 retcode 非 0 且提示请求过于频繁
 * 只对 JSON 响应做嗅探，避免把图片等大响应读进内存
 */
async function isRateLimited(res) {
  if (res.status === 429) return true
  if (!res.ok) return false
  const contentType = res.headers?.get?.('content-type') || ''
  if (!contentType.includes('json')) return false
  try {
    const data = JSON.parse(await res.clone().text())
    if (Number(data?.retcode) === 0) return false
    return RATE_LIMIT_HINT.test(String(data?.message || ''))
  } catch {
    return false
  }
}

/**
 * fetch 包装：同域名串行 + 间隔，遇到限流 / 429 / 5xx / 网络错误时退避重试。
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {{retries?:number, timeoutMs?:number, retryDelayMs?:number, rateLimitRetries?:number}} [config]
 */
export async function fetchWithRetry(url, options = {}, config = {}) {
  const { retries = 1, timeoutMs = 15000, retryDelayMs = 600, rateLimitRetries = 2 } = config
  const host = hostOf(url)
  const { signal, ...rest } = options

  const once = () =>
    enqueue(host, () =>
      fetch(url, {
        ...rest,
        signal: signal || AbortSignal.timeout(timeoutMs),
      }),
    )

  let networkLeft = retries
  let rateLimitLeft = rateLimitRetries
  let attempt = 0

  while (true) {
    try {
      const res = await once()
      attempt += 1
      if (rateLimitLeft > 0 && (await isRateLimited(res))) {
        rateLimitLeft -= 1
        await sleep(800 * attempt)
        continue
      }
      if ((res.status === 429 || res.status >= 500) && networkLeft > 0) {
        networkLeft -= 1
        let delay = retryDelayMs * attempt
        const retryAfter = Number(res.headers?.get?.('retry-after'))
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          delay = Math.min(3000, retryAfter * 1000)
        }
        await sleep(delay)
        continue
      }
      return res
    } catch (error) {
      if (networkLeft <= 0) throw error
      networkLeft -= 1
      attempt += 1
      await sleep(retryDelayMs * attempt)
    }
  }
}
