const PORT = process.env.CDP_PORT ?? '9510'
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

await call('Page.bringToFront')
await sleep(1200)

// 打开一个有内容的文件
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',ctrlKey:true,bubbles:true,cancelable:true}))`)
await sleep(700)
await ev(`(() => { const i = [...document.querySelectorAll('.overlay .modal')].pop().querySelector('input[type=text]'); i.value='索引使用建议'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await sleep(300)
await ev(`document.querySelector('.quick-item')?.click()`)
await sleep(900)

// Ctrl+F（CodeMirror 的 keymap 挂在编辑器 DOM 上，事件要派发到 .cm-content）
await ev(`document.querySelector('.cm-content').focus()`)
await ev(`document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',keyCode:70,ctrlKey:true,bubbles:true,cancelable:true}))`)
await sleep(700)
console.log('面板存在:', await ev(`!!document.querySelector('.th-search')`))
console.log('输入框数:', await ev(`document.querySelectorAll('.th-search-input').length`))
console.log('按钮:', await ev(`[...document.querySelectorAll('.th-search button')].map(b=>b.textContent).join(' | ')`))
console.log('占位提示:', await ev(`[...document.querySelectorAll('.th-search-input')].map(i=>i.placeholder).join(' / ')`))

await ev(`(() => { const i = document.querySelectorAll('.th-search-input')[0]; i.value='索引'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await sleep(600)
console.log('匹配计数:', await ev(`document.querySelector('.th-search-count')?.textContent`))

await ev(`[...document.querySelectorAll('.th-search button')].find(b=>b.textContent==='↓').click()`)
await sleep(500)
console.log('跳到下一处后光标位置:', await ev(`(() => { const s = document.querySelector('.cm-selectionBackground'); return s ? '有选区' : '无选区' })()`))

// 切一个选项
await ev(`[...document.querySelectorAll('.th-search .th-chip')][1].click()`)
await sleep(400)
console.log('正则 chip 状态:', await ev(`[...document.querySelectorAll('.th-search .th-chip')].map(c=>c.textContent + '=' + c.classList.contains('active')).join(' ')`))

// Esc 关闭
await ev(`document.querySelectorAll('.th-search-input')[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
await sleep(400)
console.log('关闭后还存在:', await ev(`!!document.querySelector('.th-search')`))
ws.close()
