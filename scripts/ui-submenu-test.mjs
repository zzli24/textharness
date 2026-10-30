const PORT = process.env.CDP_PORT ?? '9750'
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

// 造点内容，方便测查找
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await sleep(400)
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.insertText', { text: 'alpha\nBRAVO\ncharlie\nBRAVO' })
await sleep(400)

// 打开右键菜单
const line = await ev(`(() => { const l = document.querySelector('.cm-line'); const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`)
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: line.x, y: line.y, button: 'right', buttons: 2, clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line.x, y: line.y, button: 'right', buttons: 0, clickCount: 1 })
await sleep(500)
console.log('① 顶层菜单项:', JSON.stringify(await ev(`[...document.querySelectorAll('.ctx-menu:not(.submenu) button')].map(b => b.textContent.trim())`)))

// 悬停「文本处理」→ 出现子菜单
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent.includes('文本处理')); b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); return 1 })()`)
await sleep(400)
console.log('② 子菜单项:', JSON.stringify(await ev(`[...document.querySelectorAll('.ctx-menu.submenu button')].map(b => b.textContent.trim())`)))
console.log('   子菜单位置:', JSON.stringify(await ev(`(() => { const s = document.querySelector('.ctx-menu.submenu'); const r = s.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width) }; })()`)))

// 点子菜单里的「升序排列」验证功能仍可用
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu.submenu button')].find(x => x.textContent === '升序排列'); b?.click(); return 1 })()`)
await sleep(500)
console.log('③ 排序后内容:', JSON.stringify(await ev(`[...document.querySelectorAll('.cm-line')].map(l => l.textContent)`)))

// 再打开菜单点「在本文中查找 / 替换」
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: line.x, y: line.y, button: 'right', buttons: 2, clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line.x, y: line.y, button: 'right', buttons: 0, clickCount: 1 })
await sleep(400)
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent.includes('在本文中查找')); b?.click(); return 1 })()`)
await sleep(600)
console.log('④ 查找面板:', await ev(`!!document.querySelector('.cm-search')`), ' 文件夹搜索弹窗:', await ev(`document.querySelector('.overlay .modal h2')?.textContent ?? '无'`))
ws.close()
