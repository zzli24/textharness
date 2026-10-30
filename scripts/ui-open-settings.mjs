const PORT = process.env.CDP_PORT ?? '9343'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
ws.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: "document.getElementById('btn-settings').click(); 'opened'", returnByValue: true },
  })
)
await new Promise((r) => setTimeout(r, 800))
console.log('settings opened')
ws.close()
