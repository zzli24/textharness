/**
 * agent 循环的单元测试（不需要真的模型）。
 *
 * 做法：用 esbuild 把 TS 源码打成一个临时 ESM，再 mock globalThis.fetch 返回 SSE。
 * 覆盖：纯文本回合 / 工具调用回合 / 打转检测 / 429 重试 / 用量回报。
 *
 * 运行：node scripts/test-agent.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url' // 仅用于诊断
import { resolve } from 'node:path'

const root = process.cwd()
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const outfile = resolve(root, '.tmp/agent.bundle.cjs')
await build({
  entryPoints: [resolve(root, 'src/main/services/agent.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  alias: { '@shared': resolve(root, 'src/shared'), electron: resolve(root, 'scripts/electron-stub.mjs') },
  // 本地向量模型带原生 .node 二进制，测试里用不到，external 掉
  external: ['@xenova/transformers', 'onnxruntime-node', 'sharp'],
  logLevel: 'error',
})

// CJS 打包产物：用 createRequire 加载，避免 ESM 里 dynamic require 的限制
const { createRequire } = await import('node:module')
const requireCjs = createRequire(import.meta.url)
const { runAgent } = requireCjs(outfile)

/* ---------------- 测试脚手架 ---------------- */
let passed = 0
const failures = []

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${extra ? `（${extra}）` : ''}`)
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const textRound = (text, usage) => [
  { choices: [{ delta: { content: text } }] },
  ...(usage ? [{ choices: [{ delta: {} }], usage }] : []),
]

const toolRound = (name, args) => [
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  },
]

const cfg = {
  workspaceRoot: resolve(root, '.tmp/agent-test-ws'),
  assetsDir: '.assets',
  llmBaseUrl: 'http://mocked.local/v1',
  llmModel: 'mock',
  llmApiKey: 'sk-mock',
  llmReasoning: 'auto',
}

const toolContext = {
  root: cfg.workspaceRoot,
  assetsDir: '.assets',
}

function baseOptions(extra = {}) {
  return {
    cfg,
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    events: { onDelta: () => {}, onTool: () => {} },
    toolContext,
    maxSteps: 5,
    ...extra,
  }
}

/* ---------------- 1. 纯文本 + usage ---------------- */
console.log('1) 纯文本回合')
{
  const usage = { prompt_tokens: 11, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } }
  globalThis.fetch = async () => sseResponse(textRound('你好', usage))
  let text = ''
  let reported = null
  const result = await runAgent(
    baseOptions({
      events: {
        onDelta: (kind, delta) => {
          if (kind === 'content') text += delta
        },
        onTool: () => {},
        onUsage: (usageDelta) => {
          reported = usageDelta
        },
      },
    })
  )
  check('返回 1 步', result.steps === 1, `steps=${result.steps}`)
  check('拼出完整文本', text === '你好', text)
  check('上报 usage', reported?.prompt === 11 && reported?.completion === 7, JSON.stringify(reported))
  check('思考 token 也算进来', reported?.reasoning === 3, JSON.stringify(reported))
}

/* ---------------- 2. 工具调用后收尾 ---------------- */
console.log('2) 工具调用回合')
{
  let call = 0
  globalThis.fetch = async () => {
    call += 1
    if (call === 1) return sseResponse(toolRound('read_file', { path: '不存在的文件.txt' }))
    return sseResponse(textRound('读不到，换个路径'))
  }
  const tools = []
  const result = await runAgent(
    baseOptions({
      events: {
        onDelta: () => {},
        onTool: (event) => tools.push(event.name ?? event),
      },
    })
  )
  check('走了两步（工具 + 收尾）', result.steps === 2, `steps=${result.steps}`)
  check('工具事件里有 read_file', JSON.stringify(tools).includes('read_file'), JSON.stringify(tools))
}

/* ---------------- 3. 打转检测 ---------------- */
console.log('3) 重复调用检测')
{
  globalThis.fetch = async () => sseResponse(toolRound('read_file', { path: '同一个文件.txt' }))
  let notice = ''
  const result = await runAgent(
    baseOptions({
      maxSteps: 8,
      events: {
        onDelta: (kind, delta) => {
          if (kind === 'content') notice += delta
        },
        onTool: () => {},
      },
    })
  )
  check('提前结束（3 步内）', result.steps <= 4, `steps=${result.steps}`)
  check('给出打转提示', /打转|重复/.test(notice), notice.slice(0, 60))
}

/* ---------------- 4. 429 重试 ---------------- */
console.log('4) 429 重试')
{
  let attempts = 0
  const retries = []
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts <= 2) return new Response('{"error":"rate"}', { status: 429 })
    return sseResponse(textRound('重试成功'))
  }
  let text = ''
  const result = await runAgent(
    baseOptions({
      events: {
        onDelta: (kind, delta) => {
          if (kind === 'content') text += delta
        },
        onTool: () => {},
        onRetry: (attempt, reason) => retries.push(`${attempt}:${reason}`),
      },
    })
  )
  check('总共请求 3 次', attempts === 3, `attempts=${attempts}`)
  check('汇报了 2 次重试', retries.length === 2, JSON.stringify(retries))
  check('最终拿到结果', result.steps === 1 && text === '重试成功', text)
}

/* ---------------- 5. 不可重试的错误直接失败 ---------------- */
console.log('5) 401 不重试')
{
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return new Response('unauthorized', { status: 401 })
  }
  let error = ''
  try {
    await runAgent(baseOptions())
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  check('只请求 1 次', attempts === 1, `attempts=${attempts}`)
  check('错误被翻译成人话', /鉴权失败/.test(error), error.slice(0, 40))
}

/* ---------------- 6. 模型不认 max_tokens 时自动换字段 ---------------- */
console.log('6) 参数兼容：max_tokens → max_completion_tokens')
{
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    }
    return sseResponse(textRound('换字段后成功'))
  }

  let text = ''
  const result = await runAgent(
    baseOptions({
      cfg: { ...cfg, llmModel: 'relay-model-x' },
      events: {
        onDelta: (kind, delta) => {
          if (kind === 'content') text += delta
        },
        onTool: () => {},
      },
    })
  )
  check('第一次带的是 max_tokens', 'max_tokens' in bodies[0], JSON.stringify(Object.keys(bodies[0] ?? {})))
  check(
    '第二次改成 max_completion_tokens',
    bodies[1] && 'max_completion_tokens' in bodies[1] && !('max_tokens' in bodies[1]),
    JSON.stringify(Object.keys(bodies[1] ?? {}))
  )
  check('最终拿到回答', result.steps === 1 && text === '换字段后成功', text)
}

/* ---------------- 汇总 ---------------- */
console.log('')
if (failures.length > 0) {
  console.log(`结果：${passed} 通过 / ${failures.length} 失败`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`结果：${passed} 通过 / 0 失败`)
