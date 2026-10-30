const PORT = process.env.CDP_PORT ?? '9345'
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
const ev = async (expr, awaitPromise = true) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) return { ERROR: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result?.value
}

const snap = () =>
  ev(`({
    tab: document.querySelector('.tab.active .title')?.textContent,
    lines: document.querySelectorAll('.cm-line').length,
    text: (document.querySelector('.cm-content')?.innerText ?? '').slice(0, 40),
    colBtn: document.getElementById('st-column')?.textContent,
    focused: document.activeElement?.className,
  })`)

console.log('当前状态:', JSON.stringify(await snap()))

await call('Page.bringToFront')
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
console.log('新建后:', JSON.stringify(await snap()))

await ev(`document.querySelector('.cm-content')?.focus(); 1`)
await call('Input.insertText', { text: 'AAAA\nBBBB\nCCCC' })
await new Promise((r) => setTimeout(r, 300))
console.log('输入后:', JSON.stringify(await snap()))

await ev(`document.getElementById('st-column').click(); 1`)
await new Promise((r) => setTimeout(r, 300))
console.log('点列按钮后:', JSON.stringify(await snap()))

ws.close()
