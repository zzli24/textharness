const PORT = process.env.CDP_PORT ?? '9480'
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

await call('Page.bringToFront')
await new Promise((r) => setTimeout(r, 800))

const rows = await ev(`[...document.querySelectorAll('.tree .row .name')].map(e => e.textContent)`)
console.log('树里的条目:', JSON.stringify(rows))
console.log('含 .assets:', rows.includes('.assets'))

// 打开设置
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true,cancelable:true}))`)
await new Promise((r) => setTimeout(r, 900))
console.log('设置标题:', await ev(`[...document.querySelectorAll('.overlay .modal h2')].pop()?.textContent`))
console.log(
  '图库行:',
  await ev(`(() => {
    const labels = [...document.querySelectorAll('.overlay .modal .body > label')];
    const row = labels.find(l => l.textContent.includes('图库目录'));
    if (!row) return null;
    return { label: row.firstChild.textContent, path: row.querySelector('input')?.value, btn: row.querySelector('button')?.textContent };
  })()`)
)
ws.close()
