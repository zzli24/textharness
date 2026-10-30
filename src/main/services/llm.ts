import type { AppConfig, ModelInfo } from '@shared/types'

const DEFAULT_BASE = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'

interface ResolvedModel {
  baseURL: string
  model: string
  apiKey: string
  /** 推理等级；auto 表示不发送 reasoning_effort */
  reasoning: string
  /** 凭据来源，直接显示给用户 */
  origin: string
}

/**
 * 模型接入只认显式配置：
 *   1. 应用设置里填的（config.json）
 *   2. 环境变量（方便 CI / 高级用户）
 * 早先那套"扫描 ~/.dsh 自动发现"已经移除——大多数机器上根本没有这个目录，
 * 隐式读取别的软件凭据既不可预期也不安全。
 */
export function resolveModel(cfg: AppConfig): ResolvedModel {
  const baseURL = (
    cfg.llmBaseUrl ||
    process.env['TEXTHARNESS_BASE_URL'] ||
    process.env['OPENAI_BASE_URL'] ||
    DEFAULT_BASE
  ).replace(/\/+$/, '')

  const model = cfg.llmModel || process.env['TEXTHARNESS_MODEL'] || process.env['OPENAI_MODEL'] || DEFAULT_MODEL

  const envKey = process.env['TEXTHARNESS_API_KEY'] || process.env['OPENAI_API_KEY'] || ''
  const apiKey = cfg.llmApiKey || envKey

  const origin = cfg.llmApiKey ? '设置' : envKey ? '环境变量' : '未配置'
  return { baseURL, model, apiKey, reasoning: cfg.llmReasoning ?? 'auto', origin }
}

export function modelInfo(cfg: AppConfig): ModelInfo {
  const m = resolveModel(cfg)
  return {
    baseURL: m.baseURL,
    model: m.model,
    hasKey: Boolean(m.apiKey),
    source: cfg.llmApiKey ? 'settings' : m.apiKey ? 'env' : 'none',
    origin: m.origin,
  }
}

/** 接口拉不到时的兜底清单，按 baseURL 猜服务商 */
function fallbackModels(baseURL: string): string[] {
  if (/api\.deepseek\.com/i.test(baseURL)) return ['deepseek-chat', 'deepseek-reasoner']
  if (/openai\.com/i.test(baseURL)) return ['gpt-4o-mini', 'gpt-4o']
  return ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']
}

/**
 * 从网关拉真实模型列表（OpenAI 兼容的 GET /models）。
 * 拉不到就退回按服务商推断的清单，不让选择器空着。
 */
export async function listModels(cfg: AppConfig): Promise<{ models: string[]; error?: string }> {
  const m = resolveModel(cfg)
  const fallback = fallbackModels(m.baseURL)
  if (!m.apiKey) return { models: fallback, error: '还没填 API Key' }

  try {
    const res = await fetch(`${m.baseURL}/models`, {
      headers: { authorization: `Bearer ${m.apiKey}` },
      signal: AbortSignal.timeout(8000),
    })

    if (res.status === 401 || res.status === 403) {
      return { models: fallback, error: 'Key 无效或无权限（/models 需要鉴权）' }
    }
    if (res.status === 404) {
      return { models: fallback, error: '该地址没有 /models 接口' }
    }
    if (!res.ok) {
      return { models: fallback, error: `HTTP ${res.status}` }
    }

    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (json.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id))
      .sort((a, b) => a.localeCompare(b))

    if (models.length === 0) return { models: fallback, error: '接口没有返回模型' }
    return { models }
  } catch (err) {
    return { models: fallback, error: err instanceof Error ? err.message : String(err) }
  }
}
