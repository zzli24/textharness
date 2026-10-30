const PORT = process.env.CDP_PORT ?? '9492'
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

console.log('th keys:', await ev(`Object.keys(window.th).join(',')`))
console.log('state keys:', await ev(`Object.keys(window.th.state ?? {}).join(',')`))

await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`)
await new Promise((r) => setTimeout(r, 400))
console.log(
  '直接调用 save:',
  JSON.stringify(
    await ev(`window.th.state.save({ tabs: [{ path: null, title: 'probe', text: 'abc', dirty: true }], activeIndex: 0, cleanExit: false }).then(() => 'ok').catch(e => String(e))`)
  )
)
await new Promise((r) => setTimeout(r, 800))
console.log('load 回读:', JSON.stringify(await ev(`window.th.state.load()`)))
ws.close()
