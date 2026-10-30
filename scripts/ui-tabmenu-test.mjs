const PORT = process.env.CDP_PORT ?? '9520'
let page = null
for (let i = 0; i < 100; i += 1) {
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
const tabs = () => ev(`[...document.querySelectorAll('.tab .title')].map(t => t.textContent)`)

await call('Page.bringToFront')
await sleep(1200)

// 打开两个文件
for (const name of ['索引使用建议', '索引']) {
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',ctrlKey:true,bubbles:true,cancelable:true}))`)
  await sleep(600)
  await ev(`(() => { const i = [...document.querySelectorAll('.overlay .modal')].pop().querySelector('input[type=text]'); i.value=${JSON.stringify(name)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
  await sleep(300)
  await ev(`document.querySelector('.quick-item')?.click()`)
  await sleep(800)
}
console.log('标签:', JSON.stringify(await tabs()))

// 右键第一个 tab
await ev(`(() => {
  const tab = document.querySelector('.tab');
  const r = tab.getBoundingClientRect();
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
  return 1
})()`)
await sleep(400)
console.log('菜单项:', await ev(`[...document.querySelectorAll('.ctx-menu button')].map(b => b.textContent)`))

// 点“关闭其他”
await ev(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu button')].find(x => x.textContent === '关闭其他');
  if (!b) return false; b.click(); return true
})()`)
await sleep(900)
console.log('关闭其他后:', JSON.stringify(await tabs()))
console.log('菜单已关:', await ev(`!document.querySelector('.ctx-menu')`))
ws.close()
