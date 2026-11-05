/**
 * 模型参数差异：不同模型对「输出上限 / 温度 / 推理等级」的字段要求不一样。
 *
 * 踩过的坑（都来自真实模型）：
 *  1. o 系列 / gpt-5 只认 max_completion_tokens，用 max_tokens 直接 400；
 *  2. 这些模型不接受自定义 temperature（只允许默认值）；
 *  3. gpt-6-sol 这类模型在**带工具**时不允许默认推理，必须显式
 *     `reasoning_effort: 'none'`，否则报
 *     "Function tools with reasoning_effort are not supported ... set reasoning_effort to 'none'"。
 *
 * 策略：
 *  - 先按模型名猜一个组合；
 *  - 真报错了从报文里学，逐次纠正后重试（一次请求可能连续踩多个坑）；
 *  - 学到的结论缓存在进程内，之后同一个模型不再试错。
 */

import { readFileSync, writeFileSync } from 'node:fs'

export type TokenField = 'max_tokens' | 'max_completion_tokens'

/** undefined = 按用户配置；'none' = 强制 none；null = 完全不发 */
export type ReasoningEffort = 'none' | null | undefined

export interface ModelParams {
  tokenField: TokenField
  /** 能不能带 temperature */
  temperature: boolean
  /** reasoning_effort 的处理方式 */
  reasoningEffort: ReasoningEffort
}

interface Override {
  tokenField?: TokenField
  temperature?: boolean
  reasoningEffort?: ReasoningEffort
}

const overrides = new Map<string, Override>()

/** 学到的结论落盘，重开应用也不用再撞一次 400 */
let cacheFile: string | null = null

export function setParamCacheFile(path: string): void {
  cacheFile = path
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Override>
    for (const [model, value] of Object.entries(raw)) {
      if (value && typeof value === 'object') overrides.set(model, value)
    }
  } catch {
    /* 没有缓存文件或格式不对，忽略 */
  }
}

function persist(): void {
  if (!cacheFile) return
  try {
    writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(overrides), null, 2), 'utf8')
  } catch {
    /* 写不进去也不影响使用 */
  }
}

/** 按模型名做初判：o1/o3/o4-mini、gpt-5、gpt-4.1 走新字段 */
function guess(model: string): ModelParams {
  const name = model.trim().toLowerCase()
  const modern = /^(o[1-9]\b|o[1-9][-.])/.test(name) || /^gpt-5/.test(name) || /^gpt-4\.1/.test(name)
  // gpt-6 这类模型（实测 gpt-6-sol）：
  //  - 带工具时必须显式 reasoning_effort: 'none'，否则 400
  //  - temperature 只接受默认值
  const needsNone = /^gpt-6/.test(name)
  return {
    tokenField: modern ? 'max_completion_tokens' : 'max_tokens',
    temperature: !modern && !needsNone,
    reasoningEffort: needsNone ? 'none' : undefined,
  }
}

export function paramsFor(model: string): ModelParams {
  const saved = overrides.get(model) ?? {}
  return { ...guess(model), ...saved }
}

/**
 * 从 400 报文里学习正确的参数组合。
 * 返回 true 表示「识别出了可纠正的问题」，调用方应该用新参数再发一次。
 * 已经是目标状态时返回 false（避免原地重试）。
 */
export function noteParamError(model: string, message: string): boolean {
  const text = message.toLowerCase()
  const saved = overrides.get(model) ?? {}

  const wantsNewField = /use\s+'?max_completion_tokens'?/.test(text)
  const wantsOldField = /use\s+'?max_tokens'?/.test(text)

  // 输出上限字段
  if (
    wantsNewField ||
    (text.includes('max_completion_tokens') && /max_tokens.*(unsupported|not supported|not allowed)/.test(text))
  ) {
    if (saved.tokenField === 'max_completion_tokens') return false
    overrides.set(model, { ...saved, tokenField: 'max_completion_tokens' })
    persist()
    return true
  }
  if (wantsOldField && text.includes('max_completion_tokens')) {
    if (saved.tokenField === 'max_tokens') return false
    overrides.set(model, { ...saved, tokenField: 'max_tokens' })
    persist()
    return true
  }

  // reasoning_effort：带工具时被拒，报文一般会建议设成 none
  if (text.includes('reasoning_effort')) {
    if (/reasoning_effort.*(unsupported|not supported|not allowed)/.test(text)) {
      // 报文明确建议用 none（gpt-6-sol 这类）：必须显式发 none，不能只是去掉
      if (/reasoning_effort to '?none'?|reasoning_effort='?none'?/.test(text)) {
        if (saved.reasoningEffort === 'none') return false
        overrides.set(model, { ...saved, reasoningEffort: 'none' })
        persist()
        return true
      }
      if (saved.reasoningEffort === null) return false
      overrides.set(model, { ...saved, reasoningEffort: null })
      persist()
      return true
    }
  }

  // temperature：o 系列 / gpt-6-sol 只接受默认值
  if (
    text.includes('temperature') &&
    /(unsupported|not supported|does not support|only supports|invalid value)/.test(text)
  ) {
    if (saved.temperature === false) return false
    overrides.set(model, { ...saved, temperature: false })
    persist()
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

/**
 * 决定这次请求要不要带 reasoning_effort、带什么值。
 * - 学到的 none：强制发 'none'（带工具的模型需要）
 * - 学到的 null：不发
 * - 否则：用户显式选了等级才发
 */
export function reasoningEffortFor(model: string, configured: string | undefined): string | undefined {
  const params = paramsFor(model)
  if (params.reasoningEffort === 'none') return 'none'
  if (params.reasoningEffort === null) return undefined
  if (!configured || configured === 'auto') return undefined
  return configured
}

/** 调试/测试用：清掉学习到的覆盖 */
export function resetParamOverrides(): void {
  overrides.clear()
}
