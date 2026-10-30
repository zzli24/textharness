const PORT = process.env.CDP_PORT ?? '9401'
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

/* ---------- 1. 图片协议 ---------- */
const abs = 'C:\\Users\\lizhongzheng\\Documents\\随写\\agent-ws\\.assets\\img\\2026-10-28\\233136-c36d43e0.png'
const url = 'th-asset://local/' + encodeURIComponent(abs)
console.log(
  '协议:',
  JSON.stringify(
    await ev(`fetch(${JSON.stringify(url)}).then(async r => ({ status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength })).catch(e => ({ err: String(e) }))`)
  )
)
console.log(
  'img:',
  JSON.stringify(
    await ev(`new Promise(res => { const i = new Image(); i.onload = () => res({ ok: true, w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ ok: false }); i.src = ${JSON.stringify(url)} })`)
  )
)

/* ---------- 2. 列选择后直接输入，看是否按列替换 ---------- */
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', { text: 'AAAA\nBBBB\nCCCC' })
await new Promise((r) => setTimeout(r, 300))

await ev(`document.getElementById('st-column').click(); 1`)
await new Promise((r) => setTimeout(r, 300))

const box = await ev(`(() => {
  const L = [...document.querySelectorAll('.cm-line')];
  const a = L[0].getBoundingClientRect();
  const c = L[2].getBoundingClientRect();
  return { x1: a.left + 3, y1: a.top + a.height/2, x2: c.left + 40, y2: c.top + c.height/2 };
})()`)

await mouse('mousePressed', box.x1, box.y1)
for (let i = 1; i <= 6; i++) {
  await mouse('mouseMoved', box.x1 + ((box.x2 - box.x1) * i) / 6, box.y1 + ((box.y2 - box.y1) * i) / 6)
  await new Promise((r) => setTimeout(r, 30))
}
await mouse('mouseReleased', box.x2, box.y2)
await new Promise((r) => setTimeout(r, 300))
console.log('列选光标数:', await ev(`document.querySelectorAll('.cm-cursor').length`))

await call('Input.insertText', { text: 'ZZ' })
await new Promise((r) => setTimeout(r, 400))
console.log('按列输入后:')
console.log(await ev(`document.querySelector('.cm-content').innerText`))
ws.close()
