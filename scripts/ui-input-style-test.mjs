const PORT = process.env.CDP_PORT ?? '9390'
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

const style = (sel) =>
  ev(`(() => {
    const el = document.querySelector('${sel}');
    if (!el) return null;
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, border: s.borderColor, color: s.color, radius: s.borderRadius, padding: s.padding, h: Math.round(el.getBoundingClientRect().height) };
  })()`)

console.log('密码框  :', JSON.stringify(await style('.modal input[type=password]')))
console.log('文本框  :', JSON.stringify(await style('.modal input[type=text]')))
console.log('下拉框  :', JSON.stringify(await style('.modal select')))
ws.close()
