const PORT = process.env.CDP_PORT ?? '9400'
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

const abs = 'C:\\Users\\lizhongzheng\\Documents\\随写\\agent-ws\\.assets\\img\\2026-10-28\\233136-c36d43e0.png'
const url = 'th-asset://local/' + encodeURIComponent(abs)

console.log('URL:', url.slice(0, 60) + '…')
console.log('pathname 解码后:', await ev(`decodeURIComponent(new URL(${JSON.stringify(url)}).pathname.replace(/^\\/+/, ''))`))
console.log('403 正文:', await ev(`fetch(${JSON.stringify(url)}).then(r => r.text()).catch(e => String(e))`))
ws.close()
