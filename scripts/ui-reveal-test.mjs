const PORT = process.env.CDP_PORT ?? '9521'
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

const path = 'C:\\Users\\lizhongzheng\\Documents\\随写\\agent-ws\\2026-10-27\\索引使用建议.md'

console.log('reveal 返回:', JSON.stringify(await ev(`window.th.fs.reveal(${JSON.stringify(path)}).then(() => 'ok').catch(e => 'ERR: ' + e.message)`)))
console.log('openDir 返回:', JSON.stringify(await ev(`window.th.fs.openDir('C:\\\\Users\\\\lizhongzheng\\\\Documents\\\\随写\\\\agent-ws\\\\2026-10-27').then(r => 'ok:' + r).catch(e => 'ERR: ' + e.message)`)))
ws.close()
