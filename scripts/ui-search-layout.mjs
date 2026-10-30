const PORT = process.env.CDP_PORT ?? '9470'
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
await ev(
  `document.dispatchEvent(new KeyboardEvent('keydown',{key:'F',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`
)
await new Promise((r) => setTimeout(r, 600))
await ev(`(() => {
  const i = [...document.querySelectorAll('.overlay .modal')].pop().querySelectorAll('input[type=text]')[0];
  i.value='索引'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1
})()`)
await ev(`(() => {
  const m = [...document.querySelectorAll('.overlay .modal')].pop();
  [...m.querySelectorAll('.foot .btn')].find(b=>b.textContent==='查找全部').click();
  return 1
})()`)
await new Promise((r) => setTimeout(r, 1500))
console.log('面板尺寸:', JSON.stringify(await ev(`(() => {
  const m = [...document.querySelectorAll('.overlay .modal')].pop();
  const r = m.getBoundingClientRect();
  const list = m.querySelector('.search-results').getBoundingClientRect();
  return { modal: Math.round(r.width) + 'x' + Math.round(r.height), list: Math.round(list.height) };
})()`)))
console.log('可见行数:', await ev(`(() => {
  const box = [...document.querySelectorAll('.overlay .modal')].pop().querySelector('.search-results').getBoundingClientRect();
  return [...document.querySelectorAll('.search-hit')].filter(h => { const r = h.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom }).length;
})()`))
ws.close()
