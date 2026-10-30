const PORT = process.env.CDP_PORT ?? '9431'
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
await new Promise((r) => setTimeout(r, 500))
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', {
  text: '截图测试：\n\n![](../.assets/img/2026-10-29/094526-58bc2927.png)\n',
})
await new Promise((r) => setTimeout(r, 400))

const box = await ev(`(() => {
  const line = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('094526'));
  const r = line.getBoundingClientRect();
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
})()`)
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 40, y: box.y })
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
await new Promise((r) => setTimeout(r, 900))
console.log(
  '悬停结果:',
  JSON.stringify(await ev(`(() => { const i = document.querySelector('.th-hover img'); return i ? { ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight } : { img: false } })()`))
)
ws.close()
