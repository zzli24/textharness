import type { AppConfig } from '@shared/types'
import { resolveModel } from './llm'
import { TOOL_DEFS, buildSystemPrompt, runTool, type ToolContext } from './tools'

/** OpenAI 风格的对话消息（tool_calls 字段结构比较松，这里用宽松类型） */
export type AgentMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** 思考模式下必须原样回传给接口，否则报 400 */
  reasoning_content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface ToolEvent {
  toolCallId: string
  name: string
  args: string
  phase: 'start' | 'end'
  ok?: boolean
  summary?: string
  /** 执行耗时（毫秒），仅 end 阶段有 */
  ms?: number
}

export interface AgentEvents {
  onDelta(kind: 'content' | 'reasoning', text: string): void
  onTool(event: ToolEvent): void
}

export interface AgentOptions {
  cfg: AppConfig
  /** 不含 system 的历史消息 */
  messages: AgentMessage[]
  signal: AbortSignal
  events: AgentEvents
  toolContext: ToolContext
  maxSteps?: number
  /** 只允许这些工具（定时任务用受限集合） */
  allowedTools?: string[]
  /** 追加到系统提示词后面（任务专用指令） */
  systemExtra?: string
}

interface RoundResult {
  content: string
  /** 思考模式下模型输出的思考内容，必须原样回传 */
  reasoning: string
  calls: Array<{ id: string; name: string; args: string }>
}

async function streamRound(
  model: { baseURL: string; model: string; apiKey: string; reasoning?: string },
  messages: AgentMessage[],
  tools: typeof TOOL_DEFS,
  signal: AbortSignal,
  onDelta: AgentEvents['onDelta']
): Promise<RoundResult> {
  const res = await fetch(`${model.baseURL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      max_tokens: 4096,
      temperature: 0.2,
      // 只有用户显式选了推理等级才带这个字段：
      // 部分中转/厂商不支持时会因为未知参数直接 400
      ...(model.reasoning && model.reasoning !== 'auto'
        ? { reasoning_effort: model.reasoning }
        : {}),
    }),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`模型接口返回 ${res.status}：${detail.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let content = ''
  let reasoning = ''
  let buffer = ''

  const handlePacket = (payload: string): void => {
    if (!payload || payload === '[DONE]') return
    let json: {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_content?: string
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
        }
      }>
    }
    try {
      json = JSON.parse(payload)
    } catch {
      return
    }
    const delta = json.choices?.[0]?.delta
    if (!delta) return
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content
      onDelta('reasoning', delta.reasoning_content)
    }
    if (delta.content) {
      content += delta.content
      onDelta('content', delta.content)
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0
      const existing = calls.get(index) ?? { id: '', name: '', args: '' }
      if (call.id) existing.id = call.id
      if (call.function?.name) existing.name = call.function.name
      if (call.function?.arguments) existing.args += call.function.arguments
      calls.set(index, existing)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut: number
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) handlePacket(trimmed.slice(5).trim())
      }
    }
  }

  return {
    content,
    reasoning,
    calls: [...calls.values()].filter((c) => c.name).map((c) => ({ ...c, id: c.id || `call_${Math.random().toString(36).slice(2)}` })),
  }
}

/**
 * agent 主循环：模型 → 工具 → 模型 → … 直到不再调用工具。
 * 每一轮都是流式的，正文增量直接推给 UI。
 */
export async function runAgent(opts: AgentOptions): Promise<{ steps: number }> {
  const model = resolveModel(opts.cfg)
  if (!model.apiKey) {
    throw new Error(
      '还没有配置模型。打开「设置 → 模型接入」填 Base URL、模型名和 API Key（只有 Key 是必填），' +
        '或者设置环境变量 TEXTHARNESS_API_KEY。'
    )
  }

  const maxSteps = opts.maxSteps ?? 16
  const tools = opts.allowedTools
    ? TOOL_DEFS.filter((tool) => opts.allowedTools!.includes(tool.function.name))
    : TOOL_DEFS
  const allowed = new Set(tools.map((tool) => tool.function.name))

  const systemPrompt = opts.systemExtra
    ? `${buildSystemPrompt(opts.toolContext)}\n\n${opts.systemExtra}`
    : buildSystemPrompt(opts.toolContext)

  const messages: AgentMessage[] = [{ role: 'system', content: systemPrompt }, ...opts.messages]
  /** 连续相同工具调用计数：模型打转时提前收尾，别把步数耗光 */
  let lastSignature = ''
  let repeatCount = 0

  for (let step = 1; step <= maxSteps; step++) {
    let round: RoundResult
    try {
      round = await streamRound(model, messages, tools, opts.signal, opts.events.onDelta)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      // 思考模式下，历史里没有 reasoning_content 的 assistant 轮次会被网关拒掉。
      // 老会话（升级前存的）就是这样，这里丢掉这些轮次重试一次，别让用户卡死。
      if (step === 1 && text.includes('reasoning_content')) {
        const sanitized = messages.filter((m) => m.role !== 'assistant' || m.reasoning_content)
        if (sanitized.length !== messages.length) {
          messages.length = 0
          messages.push(...sanitized)
          round = await streamRound(model, messages, tools, opts.signal, opts.events.onDelta)
        } else {
          throw new Error(
            '这个模型要求把历史消息里的「思考过程」一并回传，但当前会话的历史里没有。\n' +
              '点右上角 ＋ 新建一个会话再问即可（旧会话是升级前保存的）。'
          )
        }
      } else {
        throw err
      }
    }

    if (round.calls.length === 0) {
      // 没有工具调用 = 终态
      return { steps: step }
    }

    const signature = round.calls.map((call) => `${call.name}:${call.args}`).join('|')
    repeatCount = signature === lastSignature ? repeatCount + 1 : 1
    lastSignature = signature
    if (repeatCount >= 3) {
      opts.events.onDelta('content', '\n\n> 已停止：模型连续 3 次重复同一个工具调用，判定为打转。')
      return { steps: step }
    }

    messages.push({
      role: 'assistant',
      content: round.content || null,
      // 网关要求把思考内容原样带回，否则下一轮直接 400
      ...(round.reasoning ? { reasoning_content: round.reasoning } : {}),
      tool_calls: round.calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args },
      })),
    })

    for (const call of round.calls) {
      opts.events.onTool({ toolCallId: call.id, name: call.name, args: call.args, phase: 'start' })
      const toolStarted = Date.now()

      let parsed: unknown = {}
      try {
        parsed = call.args ? JSON.parse(call.args) : {}
      } catch {
        parsed = {}
      }

      const result = allowed.has(call.name)
        ? await runTool(call.name, parsed, opts.toolContext)
        : { ok: false, text: `当前任务不允许使用工具 ${call.name}` }

      opts.events.onTool({
        toolCallId: call.id,
        name: call.name,
        args: call.args,
        phase: 'end',
        ok: result.ok,
        summary: result.text.slice(0, 600),
        ms: Date.now() - toolStarted,
      })

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        // 工具输出回传给模型时留足空间：以前卡 12000 字符，
        // 读大文件会被从中间切断，模型就会以为"文件被截断了"
        content:
          result.text.length > 48_000
            ? `${result.text.slice(0, 48_000)}\n…（工具输出过长已截断，共 ${result.text.length} 字符；请用 offset/limit 分段读取）`
            : result.text,
      })
    }
  }

  throw new Error(`达到最大步数 ${maxSteps}，已停止。\n下一步：直接说"继续"，我会接着上次的进度往下做；如果是方向不对，换个说法告诉我目标即可。`)
}
