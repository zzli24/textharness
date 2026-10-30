const PORT = process.env.CDP_PORT ?? '9750'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await call('Page.bringToFront')
await sleep(300)

// 造点内容
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await sleep(400)
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.insertText', { text: 'alpha\nbravo\ncharlie\ndelta' })
await sleep(400)

const line = await ev(`(() => { const l = document.querySelectorAll('.cm-line')[1]; const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 70), y: Math.round(r.top + r.height / 2) }; })()`)
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: line.x, y: line.y, button: 'right', buttons: 2, clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line.x, y: line.y, button: 'right', buttons: 0, clickCount: 1 })
await sleep(400)
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent.includes('文本处理')); b?.dispatchEvent(new MouseEvent('mouseenter')); return 1 })()`)
await sleep(500)
console.log('顶层:', JSON.stringify(await ev(`[...document.querySelectorAll('.ctx-menu:not(.submenu) button')].map(b => b.textContent.trim())`)))
console.log('子菜单:', JSON.stringify(await ev(`[...document.querySelectorAll('.ctx-menu.submenu button')].map(b => b.textContent.trim())`)))
ws.close()
