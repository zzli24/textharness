const PORT = process.env.CDP_PORT ?? '9600'
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
const mouse = (type, x, y, extra = {}) =>
  call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    ...extra,
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const selection = () =>
  ev(`(() => {
    const s = window.getSelection();
    return { text: s ? s.toString().slice(0, 40) : '', ranges: s ? s.rangeCount : 0,
             colMode: !!document.querySelector('.cm-editor.col-mode') };
  })()`)

await call('Page.bringToFront')
await sleep(1000)

// 确保列模式关闭
const colOn = await ev(`!!document.querySelector('.cm-editor.col-mode')`)
if (colOn) {
  await ev(`document.getElementById('st-column').click()`)
  await sleep(300)
}
console.log('列模式:', await ev(`!!document.querySelector('.cm-editor.col-mode')`))

// 找一行有文字的内容
const line = await ev(`(() => {
  const lines = [...document.querySelectorAll('.cm-line')];
  const target = lines.find(l => l.textContent.trim().length > 12);
  if (!target) return null;
  const r = target.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), text: target.textContent.slice(0, 30) };
})()`)
console.log('目标行:', JSON.stringify(line))

// 1) 同一行内拖拽
await mouse('mousePressed', line.x + 12, line.y)
for (let i = 1; i <= 6; i += 1) {
  await mouse('mouseMoved', line.x + 12 + i * 8, line.y)
  await sleep(25)
}
await mouse('mouseReleased', line.x + 60, line.y)
await sleep(300)
console.log('① 同一行拖拽:', JSON.stringify(await selection()))

// 2) Shift + 点击
await mouse('mousePressed', line.x + 8, line.y)
await mouse('mouseReleased', line.x + 8, line.y)
await sleep(200)
await call('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: line.x + 80,
  y: line.y,
  button: 'left',
  buttons: 1,
  clickCount: 1,
  modifiers: 8,
})
await call('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: line.x + 80,
  y: line.y,
  button: 'left',
  buttons: 0,
  clickCount: 1,
  modifiers: 8,
})
await sleep(300)
console.log('② Shift+点击:', JSON.stringify(await selection()))

// 3) 双击选中单词
await mouse('mousePressed', line.x + 20, line.y, { clickCount: 2 })
await mouse('mouseReleased', line.x + 20, line.y, { clickCount: 2 })
await sleep(300)
console.log('③ 双击:', JSON.stringify(await selection()))
ws.close()
