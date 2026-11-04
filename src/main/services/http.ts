/**
 * 带重试与超时的 HTTP 调用。
 *
 * 为什么需要：模型接口在高峰期会返回 429/5xx，或者连接直接断掉。
 * 之前 agent 一次失败就把整轮对话废掉，用户只能重发。
 *
 * 策略：
 *  - 只重试「值得重试」的：429、5xx、网络错误、超时
 *  - 400/401/403/404 不重试（参数错/没权限，重试也没用）
 *  - 指数退避 700ms → 1.8s，默认最多 2 次
 *  - 单次请求默认 120s 超时，可被调用方的 signal 打断
 */

export interface RetryOptions {
  retries?: number
  timeoutMs?: number
  /** 调用方自己的中断信号（用户点「停止」） */
  signal?: AbortSignal
  /** 每次重试前的回调，用于界面提示 */
  onRetry?: (attempt: number, reason: string) => void
}

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('已取消', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 发请求，返回 Response（已确认是 2xx）。失败且可重试时自动重试。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const retries = options.retries ?? 2
  const timeoutMs = options.timeoutMs ?? 120_000
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // 每次尝试单独的超时控制器；同时跟随外部 signal
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs)
    const onOuterAbort = (): void => controller.abort(new DOMException('已取消', 'AbortError'))
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })

    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (response.ok) return response

      const text = await response.text().catch(() => '')
      if (!isRetryableStatus(response.status) || attempt === retries) {
        throw new HttpError(response.status, `HTTP ${response.status}：${text.slice(0, 300)}`)
      }
      lastError = new HttpError(response.status, `HTTP ${response.status}：${text.slice(0, 120)}`)
      options.onRetry?.(attempt + 1, `HTTP ${response.status}`)
    } catch (err) {
      // 用户主动取消：立刻抛出，不重试
      if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError')

      const aborted = err instanceof DOMException && err.name === 'AbortError'
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      // 已经是明确不可重试的 HTTP 错误
      if (err instanceof HttpError && !isRetryableStatus(err.status)) throw err

      lastError = err
      if (attempt === retries) break

      const reason = timedOut ? '请求超时' : aborted ? '连接中断' : err instanceof Error ? err.message.slice(0, 60) : '网络错误'
      options.onRetry?.(attempt + 1, reason)
      await sleep(700 * (attempt + 1) ** 1.4, options.signal)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  if (lastError instanceof HttpError) throw lastError
  throw new Error(
    `请求失败（已重试 ${retries} 次）：${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

/** 把错误变成人话，给界面用 */
export function explainHttpError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return '鉴权失败：检查 API Key 是否正确/有额度'
    if (err.status === 404) return '接口地址不对：检查 Base URL 是否以 /v1 结尾'
    if (err.status === 429) return '触发限流（429）：稍等再试，或在设置里换模型'
    if (err.status >= 500) return `服务端错误（${err.status}）：多半是模型服务临时不可用`
    return err.message
  }
  if (err instanceof DOMException && err.name === 'AbortError') return '已取消'
  if (err instanceof Error) {
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err.message)) return '连不上模型服务：检查网络或 Base URL'
    return err.message
  }
  return String(err)
}
