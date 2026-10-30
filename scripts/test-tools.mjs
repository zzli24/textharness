import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dsh = join(homedir(), '.dsh')
const cred = readFileSync(join(dsh, '.credentials.yaml'), 'utf8')
const settings = readFileSync(join(dsh, 'settings.yaml.imported'), 'utf8')
const apiKey = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(cred)?.[1]
const baseURL = /baseURL:\s*(\S+)/.exec(settings)?.[1]
const model = /agent-default-model:[\s\S]*?model:\s*(\S+)/.exec(settings)?.[1]

const body = {
  model,
  messages: [
    { role: 'system', content: '你可以调用工具。需要信息时先调工具，不要凭空猜。' },
    { role: 'user', content: '列出当前目录下有哪些文件，用工具查，不要猜。' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出目录内容',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录路径，留空表示工作区根目录' } },
        },
      },
    },
  ],
  tool_choice: 'auto',
  stream: false,
  max_tokens: 512,
}

const res = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(body),
})
console.log('HTTP', res.status)
const json = await res.json()
const msg = json.choices?.[0]?.message
console.log('finish_reason:', json.choices?.[0]?.finish_reason)
console.log('content:', JSON.stringify(msg?.content ?? '').slice(0, 200))
console.log('tool_calls:', JSON.stringify(msg?.tool_calls ?? null).slice(0, 600))
