const PORT = process.env.CDP_PORT ?? '9347'
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
  return r.result?.value
}

await call('Page.bringToFront')
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true}));1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus();1`)
await call('Input.insertText', {
  text: [
    '-- 慢查询排查',
    'SELECT pid, query,',
    '       now() - query_start AS 耗时,',
    '       state',
    'FROM pg_stat_activity',
    'WHERE state = \'active\'',
    'ORDER BY query_start',
    'LIMIT 20;',
  ].join('\n'),
})
await new Promise((r) => setTimeout(r, 300))

await ev(`document.getElementById('st-column').click();1`)
await new Promise((r) => setTimeout(r, 300))

const box = await ev(`(() => {
  const lines = [...document.querySelectorAll('.cm-line')];
  const a = lines[1].getBoundingClientRect();
  const c = lines[4].getBoundingClientRect();
  return { x1: a.left + 2, y1: a.top + a.height/2, x2: a.left + 40, y2: c.top + c.height/2 };
})()`)

const mouse = (type, x, y) =>
  call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  })

await mouse('mousePressed', box.x1, box.y1)
for (let i = 1; i <= 6; i++) {
  await mouse('mouseMoved', box.x1 + ((box.x2 - box.x1) * i) / 6, box.y1 + ((box.y2 - box.y1) * i) / 6)
  await new Promise((r) => setTimeout(r, 40))
}
await mouse('mouseReleased', box.x2, box.y2)
await new Promise((r) => setTimeout(r, 400))

console.log('选区矩形数:', await ev(`document.querySelectorAll('.cm-selectionBackground').length`))
console.log('列按钮:', await ev(`document.getElementById('st-column').textContent`))
ws.close()
