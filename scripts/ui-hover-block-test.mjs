const PORT = process.env.CDP_PORT ?? '9610'
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
const mouse = (type, x, y) =>
  call('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  })
const move = (x, y) => call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const selection = () =>
  ev(`(() => {
    const s = window.getSelection();
    return s ? s.toString().slice(0, 30) : '';
  })()`)

await call('Page.bringToFront')
await sleep(1000)

// 新建一个文档，写一行含图片链接的内容
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`)
await sleep(500)
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.insertText', { text: '这是一行用来测试选中效果的文字 ![](../.assets/img/2026-10-29/demo.png) 结尾' })
await sleep(400)

// 找含图片链接的那一行
const line = await ev(`(() => {
  const target = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('.png'));
  if (!target) return null;
  const r = target.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) };
})()`)
if (!line) {
  console.log('没找到含 .png 的行')
  ws.close()
  process.exit(0)
}
console.log('目标行坐标:', JSON.stringify(line))

// ① 先悬停触发缩略图弹层
await move(line.x + 200, line.y)
await move(line.x + 30, line.y)
await sleep(900)
console.log('弹层出现:', await ev(`!!document.querySelector('.th-hover')`))
console.log(
  '弹层 pointer-events:',
  await ev(`getComputedStyle(document.querySelector('.th-hover')).pointerEvents`)
)

// ② 弹层还在时，在同一行拖拽选字
await mouse('mousePressed', line.x + 10, line.y)
for (let i = 1; i <= 5; i += 1) {
  await mouse('mouseMoved', line.x + 10 + i * 9, line.y)
  await sleep(25)
}
await mouse('mouseReleased', line.x + 55, line.y)
await sleep(300)
console.log('悬停后拖拽选中:', JSON.stringify(await selection()))
ws.close()
