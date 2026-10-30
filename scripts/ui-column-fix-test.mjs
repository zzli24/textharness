const PORT = process.env.CDP_PORT ?? '9390'
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
const mouse = (type, x, y) =>
  call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

await call('Page.bringToFront')
// 新文档 + 内容
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', { text: 'AAAA\nBBBB\nCCCC\nDDDD' })
await new Promise((r) => setTimeout(r, 300))

async function dragCols(lines, from, to) {
  const box = await ev(`(() => {
    const L = [...document.querySelectorAll('.cm-line')];
    const a = L[${lines[0]}].getBoundingClientRect();
    const c = L[${lines[1]}].getBoundingClientRect();
    return { x1: a.left + ${from}, y1: a.top + a.height/2, x2: c.left + ${to}, y2: c.top + c.height/2 };
  })()`)
  await mouse('mousePressed', box.x1, box.y1)
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', box.x1 + ((box.x2 - box.x1) * i) / 6, box.y1 + ((box.y2 - box.y1) * i) / 6)
    await new Promise((r) => setTimeout(r, 35))
  }
  await mouse('mouseReleased', box.x2, box.y2)
  await new Promise((r) => setTimeout(r, 300))
}

const stats = () =>
  ev(`({ cursors: document.querySelectorAll('.cm-cursor').length,
        ranges: document.querySelectorAll('.cm-selectionBackground').length })`)

// 1) 关闭列模式时普通拖拽
console.log('列按钮初始:', await ev(`document.getElementById('st-column').textContent`))
await dragCols([0, 2], 3, 33)
console.log('普通拖拽:', JSON.stringify(await stats()))

// 2) 打开列模式再拖
await ev(`document.getElementById('st-column').click(); 1`)
await new Promise((r) => setTimeout(r, 300))
console.log('列按钮:', await ev(`document.getElementById('st-column').textContent`))
await dragCols([0, 2], 3, 33)
console.log('列模式拖拽:', JSON.stringify(await stats()))

// 3) 复制，看剪贴板内容
const copied = await ev(`(() => {
  const dt = new DataTransfer();
  const event = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector('.cm-content').dispatchEvent(event);
  return dt.getData('text/plain');
})()`)
console.log('复制内容:', JSON.stringify(copied))

// 4) 自动闭合括号
await ev(`document.getElementById('st-column').click(); 1`)
await new Promise((r) => setTimeout(r, 200))
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', { text: 'SELECT (' })
await new Promise((r) => setTimeout(r, 300))
console.log('自动闭合后:', JSON.stringify(await ev(`document.querySelector('.cm-content').innerText`)))
ws.close()
