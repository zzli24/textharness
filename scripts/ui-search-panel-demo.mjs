const PORT = process.env.CDP_PORT ?? '9513'
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
  if (r.exceptionDetails) return { ERROR: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await call('Page.bringToFront')
await sleep(500)

// 当前文档是什么
console.log('当前标签:', await ev(`document.querySelector('.tab.active .title')?.textContent`))
console.log('文档前 40 字:', JSON.stringify((await ev(`document.querySelector('.cm-content')?.innerText ?? ''`)).slice(0, 40)))

// 打开查找面板（trusted 按键）
await ev(`document.querySelector('.cm-content').focus()`)
await call('Input.dispatchKeyEvent', {
  type: 'rawKeyDown', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
})
await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 })
await sleep(600)

await ev(`(() => {
  const inputs = document.querySelectorAll('.th-search-input');
  inputs[0].value = '索引';
  inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  inputs[1].value = '索引（已替换）';
  inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  return 1
})()`)
await sleep(500)
console.log('匹配计数:', await ev(`document.querySelector('.th-search-count')?.textContent`))

// 点“下一个”
await ev(`[...document.querySelectorAll('.th-search button')].find(b=>b.textContent==='↓').click()`)
await sleep(400)
console.log('选区:', await ev(`(() => {
  const s = window.getSelection();
  return s && s.toString() ? JSON.stringify(s.toString()) : '无';
})()`))
ws.close()
