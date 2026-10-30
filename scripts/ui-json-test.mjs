const PORT = process.env.CDP_PORT ?? '9800'
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
const newDoc = async (text) => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
  await sleep(350)
  await ev(`document.querySelector('.cm-content').focus()`)
  await call('Input.insertText', { text })
  await sleep(350)
}
const lines = () => ev(`[...document.querySelectorAll('.cm-line')].map(l => l.textContent)`)

await call('Page.bringToFront')
await sleep(1000)

/* ① 合法 JSON 格式化 */
await newDoc('{"name":"alice","age":30,"tags":["a","b"],"ok":true}')
console.log('① 格式化前:', JSON.stringify((await lines())[0]))
await ev(`document.getElementById('st-json').click()`)
await sleep(600)
console.log('   格式化后:', JSON.stringify(await lines()))
console.log('   提示:', await ev(`document.querySelector('.toast')?.textContent ?? '无'`))

/* ② 压缩回一行 */
await ev(`document.getElementById('st-json').click()`)
await sleep(300)
// 状态栏按钮是格式化；压缩走菜单，这里直接调内部函数不现实，改用全选+菜单
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
await sleep(200)
const line = await ev(`(() => { const l = document.querySelector('.cm-line'); const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`)
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: line.x, y: line.y, button: 'right', buttons: 2, clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line.x, y: line.y, button: 'right', buttons: 0, clickCount: 1 })
await sleep(400)
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent.includes('文本处理')); b?.dispatchEvent(new MouseEvent('mouseenter')); return 1 })()`)
await sleep(400)
console.log('② 子菜单:', JSON.stringify(await ev(`[...document.querySelectorAll('.ctx-menu.submenu button')].map(b => b.textContent)`)))
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu.submenu button')].find(x => x.textContent.includes('压缩')); b?.click(); return 1 })()`)
await sleep(600)
console.log('   压缩后行数:', (await lines()).length, ' 内容:', JSON.stringify((await lines())[0]))

/* ③ 非法 JSON 报错定位 */
await newDoc('{"a": 1,\n "b": }\n}')
await ev(`document.getElementById('st-json').click()`)
await sleep(500)
console.log('③ 报错提示:', await ev(`document.querySelector('.toast')?.textContent ?? '无'`))
ws.close()
