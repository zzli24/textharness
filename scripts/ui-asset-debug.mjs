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

console.log('workspaceRoot:', await ev(`window.th.config.get().then(c => c.workspaceRoot)`))
console.log('请求 URL 前缀:', url.slice(0, 40) + '…')
console.log(
  'fetch 结果:',
  JSON.stringify(
    await ev(`fetch(${JSON.stringify(url)}).then(async r => ({ status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength })).catch(e => ({ err: String(e) }))`)
  )
)

console.log(
  'img 加载:',
  JSON.stringify(
    await ev(`new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = (e) => resolve({ ok: false });
      img.src = ${JSON.stringify(url)};
    })`)
  )
)
ws.close()
