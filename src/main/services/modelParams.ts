/**
 * 模型参数差异：不同模型对「输出上限 / 温度」的字段名要求不一样。
 *
 * 典型报错：
 *   Unsupported parameter: 'max_tokens' is not supported with this model.
 *   Use 'max_completion_tokens' instead.
 * 出现在 OpenAI o 系列（o1/o3/o4-mini 等）和 gpt-5 这类新模型上；
 * 它们同时也不接受自定义 temperature（只允许默认值）。
 *
 * 策略：
 *  1. 先按模型名猜一个合理的组合；
 *  2. 真报错了再根据报文纠正，并把结论记在内存里（本次进程内不再试错）。
 */

export type TokenField = 'max_tokens' | 'max_completion_tokens'

export interface ModelParams {
  tokenField: TokenField
  /** 能不能带 temperature */
  temperature: boolean
  /** 能不能带 reasoning_effort（有的模型带工具时不支持） */
  reasoning: boolean
}

interface Override {
  tokenField?: TokenField
  temperature?: boolean
  reasoning?: boolean
}

const overrides = new Map<string, Override>()

/** 按模型名做初判：o1/o3/o4-mini、gpt-5、gpt-4.1 走新字段 */
function guess(model: string): ModelParams {
  const name = model.trim().toLowerCase()
  const modern = /^(o[1-9]\b|o[1-9][-.])/.test(name) || /^gpt-5/.test(name) || /^gpt-4\.1/.test(name)
  return {
    tokenField: modern ? 'max_completion_tokens' : 'max_tokens',
    temperature: !modern,
    reasoning: true,
  }
}

export function paramsFor(model: string): ModelParams {
  const saved = overrides.get(model) ?? {}
  return { ...guess(model), ...saved }
}

/**
 * 从 400 报文里学习正确的参数组合。
 * 返回 true 表示「识别出了可重试的问题」，调用方应该用新参数再发一次。
 */
export function noteParamError(model: string, message: string): boolean {
  const text = message.toLowerCase()
  const saved = overrides.get(model) ?? {}

  const wantsNewField = /use\s+'?max_completion_tokens'?/.test(text)
  const wantsOldField = /use\s+'?max_tokens'?/.test(text)

  // 报文明确说「用 max_completion_tokens」；或者说 max_tokens 不被支持
  if (wantsNewField || (text.includes('max_completion_tokens') && /max_tokens.*(unsupported|not supported|not allowed)/.test(text))) {
    overrides.set(model, { ...saved, tokenField: 'max_completion_tokens' })
    return true
  }
  // 反向：中转自己只认老字段
  if (wantsOldField && text.includes('max_completion_tokens')) {
    overrides.set(model, { ...saved, tokenField: 'max_tokens' })
    return true
  }

  // temperature：o 系列只接受默认值
  if (
    text.includes('temperature') &&
    /(unsupported|not supported|does not support|only supports|invalid value)/.test(text) &&
    saved.temperature !== false
  ) {
    overrides.set(model, { ...saved, temperature: false })
    return true
  }

  // reasoning_effort：有的模型 / 有的中转带工具时直接拒绝
  // 例：Function tools with reasoning_effort are not supported for gpt-6-sol ...
  if (
    text.includes('reasoning_effort') &&
    /(unsupported|not supported|not allowed|invalid)/.test(text) &&
    saved.reasoning !== false
  ) {
    overrides.set(model, { ...saved, reasoning: false })
    return true
  }

  return false
}

/** 一次请求里跟模型能力相关的字段（直接 spread 进 body） */
export function tokenParams(model: string, maxTokens: number): Record<string, unknown> {
  const params = paramsFor(model)
  const fields: Record<string, unknown> = { [params.tokenField]: maxTokens }
  if (params.temperature) fields.temperature = 0.2
  return fields
}

/** 调试/测试用：清掉学习到的覆盖 */
export function resetParamOverrides(): void {
  overrides.clear()
}
