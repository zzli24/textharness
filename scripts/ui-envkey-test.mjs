const PORT = process.env.CDP_PORT ?? '9381'
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
console.log('状态点:', await ev(`document.getElementById('ai-dot').className`))
console.log('空态标题:', await ev(`document.querySelector('.empty-chat .empty-title')?.textContent`))
console.log('建议条数:', await ev(`document.querySelectorAll('.chips button').length`))

await ev(`document.getElementById('ai-model').click(); 1`)
await new Promise((r) => setTimeout(r, 2500))
console.log('模型菜单可见:', await ev(`!document.getElementById('ai-model-menu').hidden`))
console.log('条目数:', await ev(`document.querySelectorAll('#model-list .model-item').length`))
console.log('回退提示:', await ev(`document.querySelector('#model-list .model-empty')?.textContent ?? '(无)'`))
ws.close()
