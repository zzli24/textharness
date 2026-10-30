const PORT = process.env.CDP_PORT ?? '9620'
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
  if (r.exceptionDetails) return { ERROR: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result?.value
}
const move = (x, y) => call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await call('Page.bringToFront')
await sleep(800)

const line = await ev(`(() => {
  const target = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('.png'));
  if (!target) return null;
  const r = target.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) };
})()`)
if (!line) {
  console.log('没有含 .png 的行')
  ws.close()
  process.exit(0)
}

await move(line.x + 40, line.y)
await move(line.x + 20, line.y)
await sleep(900)

console.log('弹层存在:', await ev(`!!document.querySelector('.th-hover')`))
console.log(
  '弹层祖先链:',
  await ev(`(() => {
    let el = document.querySelector('.th-hover');
    if (!el) return '无';
    const chain = [];
    while (el && el !== document.body) {
      chain.push(el.className + ' → ' + getComputedStyle(el).pointerEvents);
      el = el.parentElement;
    }
    return chain.slice(0, 4).join(' | ');
  })()`)
)
console.log(
  '该坐标命中的元素:',
  await ev(`(() => {
    const el = document.elementFromPoint(${line.x + 20}, ${line.y});
    return el ? el.className || el.tagName : '无';
  })()`)
)
ws.close()
