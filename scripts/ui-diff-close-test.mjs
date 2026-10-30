const PORT = process.env.CDP_PORT ?? '9720'
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
const openDiff = async () => {
  await ev(`document.getElementById('st-diff')?.click()`)
  await sleep(400)
}
const isOpen = () => ev(`!!document.querySelector('.overlay .modal.cmp-modal')`)

await call('Page.bringToFront')
await sleep(900)

/* ① 关闭按钮 */
await openDiff()
console.log('① 打开:', await isOpen(), '按钮:', JSON.stringify(await ev(`[...document.querySelectorAll('.overlay .modal .foot .btn')].map(b => b.textContent)`)))
await ev(`[...document.querySelectorAll('.overlay .modal .foot .btn')].find(b => b.textContent === '关闭对比')?.click()`)
await sleep(400)
console.log('   点「关闭对比」后:', await isOpen())

/* ② Esc */
await openDiff()
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(400)
console.log('② 按 Esc 后:', await isOpen())

/* ③ 点遮罩 */
await openDiff()
await ev(`(() => {
  const overlay = document.querySelector('.overlay');
  overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return 1;
})()`)
await sleep(400)
console.log('③ 点遮罩后:', await isOpen())

/* ④ 编辑 → 对比 → 返回编辑，按钮切换正确 */
await openDiff()
await ev(`(() => {
  const m = document.querySelector('.overlay .modal');
  const a = m.querySelectorAll('textarea');
  a[0].value = 'a\\nb';
  a[1].value = 'a\\nc';
  [...m.querySelectorAll('.foot .btn')].find(x => x.textContent === '开始对比').click();
  return 1;
})()`)
await sleep(400)
console.log('④ 对比态按钮:', JSON.stringify(await ev(`[...document.querySelectorAll('.overlay .modal .foot .btn')].filter(b => b.offsetParent).map(b => b.textContent)`)))
await ev(`[...document.querySelectorAll('.overlay .modal .foot .btn')].find(b => b.textContent === '返回编辑')?.click()`)
await sleep(400)
console.log('   编辑态按钮:', JSON.stringify(await ev(`[...document.querySelectorAll('.overlay .modal .foot .btn')].filter(b => b.offsetParent).map(b => b.textContent)`)))
await ev(`[...document.querySelectorAll('.overlay .modal .foot .btn')].find(b => b.textContent === '关闭对比')?.click()`)
await sleep(300)
console.log('   关闭后:', await isOpen())
ws.close()
