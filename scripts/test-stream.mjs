// 直接调用主进程用的 streamChat，验证 SSE 流式与 reasoning 字段解析
import { streamChat, resolveModel } from '../src/main/services/llm.ts'

const cfg = {
  workspaceRoot: '.',
  assetsDir: '.assets',
  harnessUrl: '',
  defaultEncoding: 'utf8',
  theme: 'dark',
  aiWidth: 420,
  sideWidth: 180,
  llmBaseUrl: '',
  llmModel: '',
  llmApiKey: '',
}

const model = resolveModel(cfg)
console.log('模型:', model.model, '| baseURL:', model.baseURL, '| 有 key:', Boolean(model.apiKey))

let reasoning = ''
let content = ''
const started = Date.now()

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 60000)

try {
  await streamChat({
    cfg,
    messages: [
      { role: 'system', content: '你是简洁的助手。' },
      { role: 'user', content: '用一句话解释 SQL 里 LEFT JOIN 和 INNER JOIN 的区别。' },
    ],
    signal: controller.signal,
    onDelta(kind, text) {
      if (kind === 'reasoning') reasoning += text
      else content += text
    },
  })
  console.log(`耗时 ${Date.now() - started}ms`)
  console.log(`思考片段 ${reasoning.length} 字 | 正文 ${content.length} 字`)
  console.log('正文:', content.slice(0, 200).replace(/\n/g, ' '))
} catch (err) {
  console.log('失败:', err.message)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
}
