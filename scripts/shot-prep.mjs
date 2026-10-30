const PORT = process.env.CDP_PORT ?? '9810'
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
await sleep(800)

// 切到 欢迎.md（有正文、图片链接、说明文字）
await ev(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('欢迎.md'));
  tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return !!tab;
})()`)
await sleep(900)
console.log('当前标签:', await ev(`document.querySelector('.tab.active .title')?.textContent`))
console.log('行数:', await ev(`document.querySelectorAll('.cm-line').length`))

// 打开右键菜单截图用不到，先关掉可能的浮层
await ev(`document.querySelectorAll('.overlay').forEach(o => o.remove())`)
await sleep(300)
ws.close()
