const PORT = process.env.CDP_PORT ?? '9380'
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
console.log('模型徽标:', await ev(`document.getElementById('ai-model').textContent`))
console.log('状态点:', await ev(`document.getElementById('ai-dot').className`))
console.log('空态标题:', await ev(`document.querySelector('.empty-chat .empty-title')?.textContent`))
console.log('空态按钮:', await ev(`document.querySelector('[data-config]')?.textContent`))

// 点空态按钮，应该打开设置
await ev(`document.querySelector('[data-config]')?.click(); 1`)
await new Promise((r) => setTimeout(r, 800))
console.log('设置弹窗已打开:', await ev(`!!document.querySelector('.overlay .modal')`))
console.log('设置里的模型状态:', await ev(`document.querySelector('.model-status')?.innerText?.replace(/\\n/g,' | ')`))
console.log('Key 输入框标签:', await ev(`[...document.querySelectorAll('.task-section label')].map(l=>l.firstChild?.textContent).join(' / ')`))
ws.close()
