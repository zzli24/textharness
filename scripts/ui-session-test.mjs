// 阶段 1：发一条消息，验证会话落盘
const PORT = process.env.CDP_PORT ?? '9360'
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

await call('Page.bringToFront')
console.log('恢复的旧会话条数:', await ev(`window.th.sessions.list().then(l => l.length)`))

await ev(`(() => {
  const input = document.getElementById('ai-input');
  input.value = '用一句话说明数据库索引是什么';
  document.getElementById('ai-send').click();
  return 'sent';
})()`)

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const busy = await ev(`document.getElementById('ai-stop').hidden === false`)
  if (!busy) break
}
console.log('回复:', (await ev(`document.querySelector('.msg.assistant:last-of-type .msg-body')?.innerText ?? ''`)).slice(0, 80))

await new Promise((r) => setTimeout(r, 800))
const sessions = await ev(`window.th.sessions.list()`)
console.log('会话列表:', JSON.stringify(sessions, null, 2))

const loaded = await ev(`window.th.sessions.load(${JSON.stringify(sessions[0]?.id ?? '')}).then(s => ({ title: s.title, count: s.messages.length }))`)
console.log('磁盘上的会话:', JSON.stringify(loaded))

await ev(`document.getElementById('ai-history').click(); 1`)
await new Promise((r) => setTimeout(r, 500))
console.log('历史菜单:', (await ev(`document.getElementById('ai-history-menu').innerText`)).replace(/\n/g, ' | '))
ws.close()
