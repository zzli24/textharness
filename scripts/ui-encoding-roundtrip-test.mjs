import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.CDP_PORT ?? '9513'
const WS = process.env.TH_WS
const file = join(WS, '_enc_roundtrip.md')

writeFileSync(file, '# 测试索引 标题\n\n索引使用建议：建立索引。\nTOKEN_ABC 结尾\n', 'utf8')

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).resolve(m.result)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const call = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, { resolve }))
}
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { ERROR: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result?.value
}

console.log(
  '替换结果:',
  JSON.stringify(
    await ev(
      `window.th.search.replace([${JSON.stringify(file)}], { query: 'TOKEN_ABC' }, 'REPLACED')`
    )
  )
)

const after = readFileSync(file, 'utf8')
console.log('替换后内容:', JSON.stringify(after))
console.log('索引还在:', after.includes('索引'))
console.log('替换生效:', after.includes('REPLACED'))
ws.close()
