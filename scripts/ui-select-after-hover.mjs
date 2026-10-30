const PORT = process.env.CDP_PORT ?? '9624'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mouse = (type, x, y) =>
  call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
const move = (x, y) => call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })

await call('Page.bringToFront')

const line = await ev(`(() => {
  const t = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('.png'));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) };
})()`)
if (!line) {
  console.log('没有含 .png 的行')
  process.exit(0)
}

// 悬停出缩略图
await move(line.x + 60, line.y)
await move(line.x + 30, line.y)
await sleep(900)
console.log('弹层:', await ev(`!!document.querySelector('.th-hover')`))
console.log(
  '缩略图:',
  JSON.stringify(
    await ev(`(() => {
      const img = document.querySelector('.th-hover img');
      if (!img) return { img: false, text: document.querySelector('.th-hover')?.textContent?.slice(0, 60) };
      return { img: true, ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth };
    })()`)
  )
)

// 弹层还在时，同一行拖拽选字
await mouse('mousePressed', line.x + 10, line.y)
for (let i = 1; i <= 5; i += 1) {
  await mouse('mouseMoved', line.x + 10 + i * 8, line.y)
  await sleep(25)
}
await mouse('mouseReleased', line.x + 50, line.y)
await sleep(300)
console.log('同拖拽选中:', JSON.stringify(await ev(`window.getSelection()?.toString().slice(0, 24)`)))
ws.close()
