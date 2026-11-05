/**
 * 拼 chat/completions 地址，并对「Base URL 填成了 Responses API 地址」给出明确提示。
 *
 * 背景：设置里允许填任意 OpenAI 兼容 Base URL。有人会填
 * `https://ai.pocketcity.com/v1/responses`（OpenAI Responses API），
 * 我们再拼 `/chat/completions` 就变成 `.../v1/responses/chat/completions`，
 * 服务端只回 404，用户看到的却是「检查 Base URL 是否以 /v1 结尾」，很难自己定位。
 */

/** 去掉结尾多余的斜杠，避免出现 `//chat/completions` */
export function trimBaseUrl(baseURL: string): string {
  return (baseURL ?? '').trim().replace(/\/+$/, '')
}

export function isResponsesApiBase(baseURL: string): boolean {
  return /\/responses$/i.test(trimBaseUrl(baseURL))
}

export function chatCompletionsUrl(baseURL: string): string {
  return `${trimBaseUrl(baseURL)}/chat/completions`
}

/**
 * 明确不支持时抛人话错误；支持就返回拼好的地址。
 * （本版本只实现 chat/completions 协议）
 */
export function resolveChatCompletionsUrl(baseURL: string): string {
  if (isResponsesApiBase(baseURL)) {
    const suggested = trimBaseUrl(baseURL).replace(/\/responses$/i, '')
    throw new Error(
      `这个 Base URL 是 Responses API 地址（/responses），本版本只支持 chat/completions。` +
        `把 Base URL 改成 ${suggested} 就能用同一个模型。`
    )
  }
  return chatCompletionsUrl(baseURL)
}
