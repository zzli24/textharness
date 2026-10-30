const PORT = process.env.CDP_PORT ?? '9421'
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
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result?.value
}

console.log('点击前 class:', await ev(`document.querySelector('.cm-editor').className`))
console.log('按钮:', await ev(`document.getElementById('st-column').textContent`))
await ev(`document.getElementById('st-column').click()`)
await new Promise((r) => setTimeout(r, 400))
console.log('点击后 class:', await ev(`document.querySelector('.cm-editor').className`))
console.log('按钮:', await ev(`document.getElementById('st-column').textContent`))
console.log('背景图:', await ev(`getComputedStyle(document.querySelector('.cm-content')).backgroundImage.slice(0, 70)`))
ws.close()
