// 验证模型列表在三种后端下的表现：官方 DeepSeek / 自建 mock / 私有网关
import { createServer } from 'node:http'

const { listModels } = await import('../src/main/services/llm.ts')

const base = {
  workspaceRoot: '.',
  assetsDir: '.assets',
  defaultEncoding: 'utf8',
  theme: 'dark',
  aiWidth: 420,
  sideWidth: 180,
  llmBaseUrl: '',
  llmModel: '',
  llmApiKey: '',
  tasks: [],
  catchUpOnLaunch: false,
}

function cfgWith(patch) {
  return { ...base, ...patch }
}

// 1) 本地 mock：模拟官方 /models 的返回结构
const server = createServer((req, res) => {
  if (req.url === '/v1/models' || req.url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const mock = await listModels(
  cfgWith({ llmBaseUrl: `http://127.0.0.1:${port}/v1`, llmModel: 'x', llmApiKey: 'k' })
)
console.log('1) 官方响应结构（本地 mock） ->', JSON.stringify(mock))

// 2) 官方地址 + 假 Key：应回退到官方清单并给出鉴权错误
const official = await listModels(
  cfgWith({ llmBaseUrl: 'https://api.deepseek.com/v1', llmModel: 'x', llmApiKey: 'sk-invalid' })
)
console.log('2) api.deepseek.com（假 Key） ->', JSON.stringify(official))

// 3) 真实私有网关（读本机 ~/.dsh）
const real = await listModels(cfgWith({}))
console.log(`3) 私有网关 -> ${real.models.length} 个模型，错误=${real.error ?? '无'}`)
console.log('   示例:', real.models.slice(0, 3).join(', '))

server.close()
