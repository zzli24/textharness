const PORT = process.env.CDP_PORT ?? '9760'
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
const rightClick = async (x, y) => {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
  await sleep(400)
}
await call('Page.bringToFront')
await sleep(1000)

/* ① 子菜单点击后应完全消失 */
const line = await ev(`(() => { const l = document.querySelectorAll('.cm-line')[1] || document.querySelector('.cm-line'); const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`)
await rightClick(line.x, line.y)
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent.includes('文本处理')); b?.dispatchEvent(new MouseEvent('mouseenter')); return 1 })()`)
await sleep(400)
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu.submenu button')].find(x => x.textContent === '转换为大写'); b?.click(); return 1 })()`)
await sleep(400)
console.log('① 菜单残留数（应为 0）:', await ev(`document.querySelectorAll('.ctx-menu').length`))

/* ② Markdown 表格 → CSV 标签 */
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await sleep(400)
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.insertText', { text: '| id | name |\n| --- | --- |\n| 1 | alice |\n| 2 | bob |' })
await sleep(400)
// 全选后走菜单「选中表格转为 CSV 标签」
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
await sleep(200)
const line2 = await ev(`(() => { const l = document.querySelector('.cm-line'); const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`)
await rightClick(line2.x, line2.y)
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent.includes('文本处理')); b?.dispatchEvent(new MouseEvent('mouseenter')); return 1 })()`)
await sleep(300)
await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu.submenu button')].find(x => x.textContent.includes('CSV 标签')); b?.click(); return 1 })()`)
await sleep(700)
console.log('② 新标签:', await ev(`document.querySelector('.tab.active .title')?.textContent`), ' 网格:', await ev(`!!document.querySelector('#grid-host.active')`))
console.log('   单元格:', JSON.stringify(await ev(`[...document.querySelectorAll('.grid-table td')].map(td => td.textContent)`)))

/* ③ 源码/表格切换 */
console.log('③ 切换按钮文字:', await ev(`document.getElementById('st-source').textContent`), ' 可见:', await ev(`getComputedStyle(document.getElementById('st-source')).display !== 'none'`))
await ev(`document.getElementById('st-source').click()`)
await sleep(600)
console.log('   切到源码后 编辑器可见:', !(await ev(`!!document.querySelector('#editor-host.hidden-by-grid')`)), ' 按钮:', await ev(`document.getElementById('st-source').textContent`))
console.log('   源码内容:', JSON.stringify(await ev(`[...document.querySelectorAll('.cm-line')].map(l => l.textContent)`)))
await ev(`document.getElementById('st-source').click()`)
await sleep(600)
console.log('   切回表格 网格:', await ev(`!!document.querySelector('#grid-host.active')`), ' 按钮:', await ev(`document.getElementById('st-source').textContent`))
ws.close()
