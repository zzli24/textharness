const PORT = process.env.CDP_PORT ?? '9670'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await call('Page.bringToFront')
await sleep(1000)

// 新文档写点内容
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await sleep(400)
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.insertText', { text: '第一行内容\n第二行内容' })
await sleep(400)

// 右键
const line = await ev(`(() => {
  const l = document.querySelector('.cm-line');
  const r = l.getBoundingClientRect();
  return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) };
})()`)
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: line.x, y: line.y, button: 'right', buttons: 2, clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line.x, y: line.y, button: 'right', buttons: 0, clickCount: 1 })
await sleep(500)
console.log('右键菜单项:', await ev(`[...document.querySelectorAll('.ctx-menu button')].map(b => b.textContent)`))
console.log('分隔线条数:', await ev(`document.querySelectorAll('.ctx-menu .ctx-sep').length`))

// 点“插入表格…”
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent.includes('插入表格')); b?.click(); return 1 })()`)
await sleep(600)
console.log('表格对话框:', await ev(`document.querySelector('.overlay .modal h2')?.textContent`))
console.log('输入框:', await ev(`[...document.querySelectorAll('.overlay .modal input[type=number]')].map(i => i.value)`))
await ev(`(() => { const b = [...document.querySelectorAll('.overlay .modal .foot .btn')].find(x => x.textContent === '确定'); b?.click(); return 1 })()`)
await sleep(600)
console.log('插入后内容:')
console.log(await ev(`document.querySelector('.cm-content')?.innerText`))
ws.close()
