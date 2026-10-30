const PORT = process.env.CDP_PORT ?? '9420'
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
const mouse = (type, x, y, extra = {}) =>
  call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })

await call('Page.bringToFront')
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', {
  text: Array.from({ length: 12 }, (_, i) => `PRODUCT_NAME_${String(i + 1).padStart(2, '0')} = value`).join('\n'),
})
await new Promise((r) => setTimeout(r, 300))

await ev(`document.getElementById('st-column').click(); 1`)
await new Promise((r) => setTimeout(r, 300))

// 横向拖出宽度的矩形：第 2 行第 1 列 → 第 9 行第 7 列
const box = await ev(`(() => {
  const L = [...document.querySelectorAll('.cm-line')];
  const a = L[1].getBoundingClientRect();
  const c = L[8].getBoundingClientRect();
  return { x1: a.left + 2, y1: a.top + a.height/2, x2: c.left + 62, y2: c.top + c.height/2 };
})()`)

await mouse('mousePressed', box.x1, box.y1)
for (let i = 1; i <= 8; i++) {
  await mouse('mouseMoved', box.x1 + ((box.x2 - box.x1) * i) / 8, box.y1 + ((box.y2 - box.y1) * i) / 8)
  await new Promise((r) => setTimeout(r, 30))
}
await mouse('mouseReleased', box.x2, box.y2)
await new Promise((r) => setTimeout(r, 400))

console.log('光标数:', await ev(`document.querySelectorAll('.cm-cursor').length`))
console.log('选区块数:', await ev(`document.querySelectorAll('.cm-selectionBackground').length`))
console.log(
  '单个选区尺寸:',
  JSON.stringify(
    await ev(`[...document.querySelectorAll('.cm-selectionBackground')].slice(0,3).map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })`)
  )
)
const copied = await ev(`(() => {
  const dt = new DataTransfer();
  document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt.getData('text/plain');
})()`)
console.log('复制结果:', JSON.stringify(copied))
ws.close()
