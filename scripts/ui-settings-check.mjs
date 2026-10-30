const PORT = process.env.CDP_PORT ?? '9350'
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
const ev = async (expr) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  const r = await new Promise((resolve) => pending.set(id, { resolve }))
  return r.result?.value
}

console.log('状态卡:', await ev(`document.querySelector('.model-status')?.innerText`))
console.log('提示:', await ev(`document.querySelector('.task-section .hint')?.textContent`))
console.log(
  '字段:',
  await ev(`[...document.querySelectorAll('.task-section label')].map(l => l.textContent + ' [' + (l.querySelector('input')?.placeholder ?? '') + ']')`)
)
console.log('标题栏徽标:', await ev(`document.getElementById('ai-model').textContent`))
ws.close()
