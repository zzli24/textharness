const PORT = process.env.CDP_PORT ?? '9570'
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

await call('Page.bringToFront')
await new Promise((r) => setTimeout(r, 800))

// 旧会话：assistant 消息没有 reasoning_content
console.log(
  '旧历史（缺 reasoning）:',
  JSON.stringify(
    await ev(`window.th.ai.chat({
      id: 'probe-old',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你？' },
        { role: 'user', content: '只回两个字：收到' },
      ],
    }).then(() => 'ok').catch(e => 'ERR: ' + String(e.message).slice(0, 120))`)
  )
)

// 新会话：正常一问
console.log(
  '新会话:',
  JSON.stringify(
    await ev(`window.th.ai.chat({
      id: 'probe-new',
      messages: [{ role: 'user', content: '只回两个字：完成' }],
    }).then(() => 'ok').catch(e => 'ERR: ' + String(e.message).slice(0, 120))`)
  )
)
ws.close()
