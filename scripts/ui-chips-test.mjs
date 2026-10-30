const PORT = process.env.CDP_PORT ?? '9550'
let page = null
for (let i = 0; i < 120; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
    if (page) break
  } catch {
    /* not ready */
  }
  await new Promise((r) => setTimeout(r, 200))
}
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await call('Page.bringToFront')
await sleep(1200)

console.log(
  '上下文开关:',
  JSON.stringify(
    await ev(`[...document.querySelectorAll('.chip-toggle')].map(l => ({
      label: l.textContent.trim(),
      checked: l.querySelector('input').checked,
      title: l.title,
    }))`)
  )
)
console.log('面板宽度:', await ev(`Math.round(document.getElementById('ai-slot').getBoundingClientRect().width)`))
console.log(
  '底栏是否溢出:',
  await ev(`(() => {
    const bar = document.querySelector('.composer-bar');
    return { scrollW: bar.scrollWidth, clientW: bar.clientWidth, overflow: bar.scrollWidth > bar.clientWidth + 1,
             barH: Math.round(bar.getBoundingClientRect().height) };
  })()`)
)
ws.close()
