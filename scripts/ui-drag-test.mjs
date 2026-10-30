// 用 CDP 真实派发鼠标事件，验证左右两条分隔线能拖动并持久化宽度
const PORT = process.env.CDP_PORT ?? '9334'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
if (!page) throw new Error('找不到页面')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))

function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, { resolve }))
}

async function evalJs(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

async function drag(selector, dx) {
  const box = await evalJs(`(() => {
    const r = document.querySelector('${selector}').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  for (let step = 1; step <= 5; step++) {
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.x + (dx * step) / 5,
      y: box.y,
      button: 'left',
      buttons: 1,
    })
    await new Promise((r) => setTimeout(r, 30))
  }
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + dx, y: box.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 200))
}

const read = () =>
  evalJs(`(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      side: cs.getPropertyValue('--side-w').trim(),
      ai: cs.getPropertyValue('--ai-w').trim(),
      sideRect: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      aiRect: Math.round(document.getElementById('ai-slot').getBoundingClientRect().width),
    };
  })()`)

console.log('拖动前:', JSON.stringify(await read()))

await drag('#side-resizer', 60)
console.log('左栏右拖 60px:', JSON.stringify(await read()))

await drag('#ai-resizer', -80)
console.log('AI 栏左拖 80px:', JSON.stringify(await read()))

const cfg = await evalJs(`window.th.config.get().then(c => ({ sideWidth: c.sideWidth, aiWidth: c.aiWidth }))`)
console.log('已持久化到配置:', JSON.stringify(cfg))

ws.close()
