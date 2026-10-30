const PORT = process.env.CDP_PORT ?? '9521'
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

// 反斜杠路径 → 知识库目录
const good = 'C:\\Users\\lizhongzheng\\Documents\\随写\\agent-ws\\知识库\\索引.md'
// 混合分隔符路径 → 运维排错目录
const mixed = 'C:\\Users\\lizhongzheng\\Documents\\随写\\agent-ws/运维排错/DBA上线前检查清单.md'

console.log('反斜杠 reveal:', await ev(`window.th.fs.reveal(${JSON.stringify(good)}).then(() => 'ok').catch(e => 'ERR ' + e.message)`))
await new Promise((r) => setTimeout(r, 2500))
console.log('混合 reveal:', await ev(`window.th.fs.reveal(${JSON.stringify(mixed)}).then(() => 'ok').catch(e => 'ERR ' + e.message)`))
await new Promise((r) => setTimeout(r, 2500))
ws.close()
