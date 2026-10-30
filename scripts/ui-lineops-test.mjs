const PORT = process.env.CDP_PORT ?? '9680'
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
const lines = () => ev(`[...document.querySelectorAll('.cm-line')].map(l => l.textContent)`)

const newDocWith = async (text) => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
  await sleep(350)
  await ev(`document.querySelector('.cm-content').focus()`)
  await call('Input.insertText', { text })
  await sleep(300)
}

const runMenu = async (label) => {
  // 全选
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await sleep(200)
  const pos = await ev(`(() => { const l = document.querySelector('.cm-line'); const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height/2) }; })()`)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'right', buttons: 2, clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'right', buttons: 0, clickCount: 1 })
  await sleep(400)
  const ok = await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  return ok
}

await call('Page.bringToFront')
await sleep(900)

await newDocWith('charlie\nALPHA\nbravo\n10\n9\n100\nbravo')
console.log('原始:', JSON.stringify(await lines()))

await runMenu('升序排列')
console.log('升序后:', JSON.stringify(await lines()))

await runMenu('降序排列')
console.log('降序后:', JSON.stringify(await lines()))

await runMenu('删除重复行')
console.log('去重后:', JSON.stringify(await lines()))

await newDocWith('select * from orders')
await runMenu('转换为大写')
console.log('大写后:', JSON.stringify(await lines()))

await newDocWith('hello world foo')
await runMenu('首字母大写')
console.log('首字母大写后:', JSON.stringify(await lines()))
ws.close()
