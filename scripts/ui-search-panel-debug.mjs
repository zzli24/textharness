const PORT = process.env.CDP_PORT ?? '9511'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).resolve(m.result)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
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

await call('Runtime.enable')
await call('Page.bringToFront')
await sleep(600)

console.log('编辑器存在:', await ev(`!!document.querySelector('.cm-content')`))
await ev(`document.querySelector('.cm-content').focus()`)
await sleep(200)
console.log('聚焦元素:', await ev(`document.activeElement?.className`))

// 用 CDP 发真实按键（trusted）
const key = async (type) =>
  call('Input.dispatchKeyEvent', {
    type,
    modifiers: 2,
    key: 'f',
    code: 'KeyF',
    windowsVirtualKeyCode: 70,
    nativeVirtualKeyCode: 70,
  })
await key('rawKeyDown')
await key('keyUp')
await sleep(800)

console.log('面板存在:', await ev(`!!document.querySelector('.th-search')`))
console.log('cm-panels 内容:', await ev(`document.querySelector('.cm-panels')?.innerHTML?.slice(0, 120) ?? '(空)'`))
console.log('错误日志:', JSON.stringify(logs.slice(0, 4)))
ws.close()
