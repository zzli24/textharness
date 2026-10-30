const PORT = process.env.CDP_PORT ?? '9440'
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
// modifiers: Alt = 1
const mouse = (type, x, y, alt) =>
  call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    modifiers: alt ? 1 : 0,
  })

await call('Page.bringToFront')
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', { text: 'alpha\nbravo\ncharlie\ndelta' })
await new Promise((r) => setTimeout(r, 300))

const box = await ev(`(() => {
  const L = [...document.querySelectorAll('.cm-line')];
  const a = L[0].getBoundingClientRect();
  const c = L[2].getBoundingClientRect();
  return { x1: a.left + 4, y1: a.top + a.height/2, x2: c.left + 34, y2: c.top + c.height/2 };
})()`)

// Alt + 拖拽
await mouse('mousePressed', box.x1, box.y1, true)
for (let i = 1; i <= 6; i++) {
  await mouse('mouseMoved', box.x1 + ((box.x2 - box.x1) * i) / 6, box.y1 + ((box.y2 - box.y1) * i) / 6, true)
  await new Promise((r) => setTimeout(r, 30))
}
await mouse('mouseReleased', box.x2, box.y2, true)
await new Promise((r) => setTimeout(r, 400))
console.log('Alt+拖拽 光标数:', await ev(`document.querySelectorAll('.cm-cursor').length`))

const copied = await ev(`(() => {
  const dt = new DataTransfer();
  document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt.getData('text/plain');
})()`)
console.log('复制结果:', JSON.stringify(copied))
console.log('菜单栏是否还存在:', await ev(`!!document.querySelector('.cm-editor') && document.body.getBoundingClientRect().height`))
ws.close()
