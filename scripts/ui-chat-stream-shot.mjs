const PORT = process.env.CDP_PORT ?? '9541'
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
await sleep(1000)
await ev(`(() => {
  const input = document.getElementById('ai-input');
  input.value = '用三句话解释 iptables 的四表五链，并给一条示例命令';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('ai-send').click();
  return 1
})()`)
await sleep(1800)
console.log(
  '流式中:',
  JSON.stringify(
    await ev(`(() => {
      const c = document.getElementById('ai-composer').getBoundingClientRect();
      const s = document.getElementById('ai-stop').getBoundingClientRect();
      return { composerVisible: c.height > 0, stop: Math.round(s.width) + 'x' + Math.round(s.height), hint: document.getElementById('ai-hint').textContent };
    })()`)
  )
)
ws.close()
