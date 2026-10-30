const PORT = process.env.CDP_PORT ?? '9410'
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

await call('Page.bringToFront')
await new Promise((r) => setTimeout(r, 800))

const target = await ev(`(() => {
  const lines = [...document.querySelectorAll('.cm-line')];
  const line = lines.find(l => l.textContent.includes('demo.png'));
  if (!line) return null;
  const r = line.getBoundingClientRect();
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2), text: line.textContent };
})()`)
console.log('目标行:', JSON.stringify(target))

if (target) {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x - 30, y: target.y })
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await new Promise((r) => setTimeout(r, 900))

  console.log('tooltip 存在:', await ev(`!!document.querySelector('.th-hover')`))
  console.log(
    '图片状态:',
    JSON.stringify(
      await ev(`(() => {
        const img = document.querySelector('.th-hover img');
        if (!img) return { img: false, text: document.querySelector('.th-hover')?.textContent ?? '' };
        return { img: true, ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 50) };
      })()`)
    )
  )
}
ws.close()
