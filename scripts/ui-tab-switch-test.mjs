// 验证切标签不丢内容（同一个 state 回写 bug 的另一个后果）
const PORT = process.env.CDP_PORT ?? '9346'
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
const text = () => ev(`document.querySelector('.cm-content').innerText.trim()`)
const tab = () => ev(`document.querySelector('.tab.active .title').textContent`)

await call('Page.bringToFront')

// 文档 A
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true}));1`)
await new Promise((r) => setTimeout(r, 250))
await ev(`document.querySelector('.cm-content').focus();1`)
await call('Input.insertText', { text: 'AAA-内容' })
await new Promise((r) => setTimeout(r, 250))
const aTitle = await tab()
const aText = await text()

// 文档 B
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true}));1`)
await new Promise((r) => setTimeout(r, 250))
await ev(`document.querySelector('.cm-content').focus();1`)
await call('Input.insertText', { text: 'BBB-内容' })
await new Promise((r) => setTimeout(r, 250))
const bText = await text()

// 切回 A
await ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('${aTitle}')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));1`)
await new Promise((r) => setTimeout(r, 400))
const backText = await text()

console.log(`A(${aTitle}) 初始: ${JSON.stringify(aText)}`)
console.log(`B 当前: ${JSON.stringify(bText)}`)
console.log(`切回 A: ${JSON.stringify(backText)}`)
console.log(backText === aText ? '✅ 切标签内容保留' : '❌ 内容丢失')
ws.close()
