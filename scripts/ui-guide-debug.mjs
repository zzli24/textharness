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
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { ERROR: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result?.value
}

console.log('editor class:', await ev(`document.querySelector('.cm-editor')?.className`))
console.log('--col-guide:', await ev(`getComputedStyle(document.documentElement).getPropertyValue('--col-guide')`))
console.log(
  'content 背景:',
  JSON.stringify(
    await ev(`(() => { const s = getComputedStyle(document.querySelector('.cm-content')); return { image: s.backgroundImage.slice(0, 90), color: s.backgroundColor, pos: s.backgroundPosition, size: s.backgroundSize } })()`)
  )
)
ws.close()
