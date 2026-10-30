const PORT = process.env.CDP_PORT ?? '9633'
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

// 返回目标行的客户区坐标 + 视口在屏幕上的原点
console.log(
  JSON.stringify(
    await ev(`(() => {
  const line = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.length > 30);
  const r = line.getBoundingClientRect();
  return {
    originX: window.screenX + 7,
    originY: window.screenY + 38,
    lineLeft: Math.round(r.left),
    lineTop: Math.round(r.top),
    lineH: Math.round(r.height),
    sample: line.textContent.slice(0, 40),
  };
})()`)
  )
)

console.log(
  '当前 CM 选区:',
  JSON.stringify(
    await ev(`(() => {
      const sel = window.getSelection();
      return { text: sel ? sel.toString().slice(0, 60) : '', len: sel ? sel.toString().length : 0 };
    })()`)
  )
)
ws.close()
