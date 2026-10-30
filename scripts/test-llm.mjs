import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dsh = join(homedir(), '.dsh')
const cred = readFileSync(join(dsh, '.credentials.yaml'), 'utf8')
const settings = readFileSync(join(dsh, 'settings.yaml.imported'), 'utf8')

const apiKey = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(cred)?.[1]
const baseURL = /baseURL:\s*(\S+)/.exec(settings)?.[1]
const model = /agent-default-model:[\s\S]*?model:\s*(\S+)/.exec(settings)?.[1]

console.log('baseURL =', baseURL)
console.log('model   =', model)
console.log('apiKey  =', apiKey ? `已读取（${apiKey.length} 字符）` : '未找到')

const res = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: '只回复两个字：通了' }],
    max_tokens: 20,
    stream: false,
  }),
})

console.log('HTTP', res.status)
const text = await res.text()
console.log('body(前 400 字符):', text.slice(0, 400))
