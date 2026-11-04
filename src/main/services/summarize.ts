import type { AppConfig } from '@shared/types'
import { resolveModel } from './llm'
import { fetchWithRetry } from './http'

/**
 * 归档前的「总结」：把一段对话/选区压成可直接进知识库的 markdown 章节。
 *
 * 走非流式 chat/completions，故意不带工具、不发 reasoning 参数：
 * 这里只要一段稳定文本，不需要模型思考过程。
 */

const SYSTEM = [
  '你是知识库编辑。把用户给的内容整理成一段可以直接放进 Obsidian/知识库的 markdown 章节。',
  '要求：',
  '1. 用二级标题（## ）分节，不要一级标题；不要写"以下是"之类的开场。',
  '2. 保留所有可执行的命令、SQL、代码块、配置项原样，不要改写；SQL 关键字大写。',
  '3. 去掉寒暄、思考过程、工具调用痕迹，只留结论与步骤。',
  '4. 中文表达，控制在 800 字以内；信息不足就写得更短，不要编。',
  '5. 直接输出 markdown 正文，不要用 ``` 包裹整段。',
].join('\n')

export async function summarizeForArchive(cfg: AppConfig, input: string, title: string): Promise<string> {
  const model = resolveModel(cfg)
  const body = {
    model: model.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `标题：${title}\n\n原始内容：\n${input.slice(0, 20_000)}` },
    ],
    temperature: 0.2,
    max_tokens: 1200,
    stream: false,
  }

  const response = await fetchWithRetry(`${model.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify(body),
  }, { retries: 2, timeoutMs: 120_000 })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`总结失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content?.trim() ?? ''
  if (!content) throw new Error('模型没有返回内容')
  return content
}

/**
 * 把新内容合并进已有文档，并重新组织整篇结构。
 * 输出「整篇新文档」，强调保留原有信息、只做结构整理，避免丢内容。
 */
export async function reorganizeForMerge(
  cfg: AppConfig,
  existing: string,
  addition: string,
  title: string
): Promise<string> {
  const model = resolveModel(cfg)
  const system = [
    '你是知识库编辑。用户有一篇已有的 markdown 笔记，还有一段新的内容要并进去。',
    '请把两者合并成一篇结构清晰的新文档。规则：',
    '1. 保留原笔记里的所有事实、命令、SQL、代码、注意事项，不要删减；只允许调整顺序、去重、归并同类项。',
    '2. 新内容作为新章节融入合适的位置；如果与原内容重复，合并成一条而不是并列两条。',
    '3. 用 ## 分节；不要写"以下是合并结果"之类的开场白。',
    '4. SQL 关键字大写；保留代码块语言标记。',
    '5. 直接输出整篇 markdown 正文，不要用代码围栏把整篇包起来。',
  ].join('\n')

  const body = {
    model: model.model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `标题：${title}\n\n【已有笔记】\n${existing.slice(0, 18000)}\n\n【要并入的新内容】\n${addition.slice(0, 8000)}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 4000,
    stream: false,
  }

  const response = await fetchWithRetry(`${model.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` },
    body: JSON.stringify(body),
  }, { retries: 2, timeoutMs: 180_000 })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`重组失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content?.trim() ?? ''
  if (!content) throw new Error('模型没有返回内容')
  return content
}
