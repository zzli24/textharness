const PORT = process.env.CDP_PORT ?? '9361'
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
  return r.result?.value
}

await call('Page.bringToFront')
await new Promise((r) => setTimeout(r, 1500))

const text = await ev(`document.getElementById('ai-messages').innerText`)
console.log('重启后的对话区:', JSON.stringify((text ?? '').slice(0, 120)))
console.log('是否恢复出用户提问:', (text ?? '').includes('数据库索引是什么'))
console.log('消息节点数:', await ev(`document.querySelectorAll('#ai-messages .msg').length`))
ws.close()
