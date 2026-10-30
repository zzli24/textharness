const PORT = process.env.CDP_PORT ?? '9633'
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

// 光标落点：anchorNode 的文本与偏移
console.log(
  JSON.stringify(
    await ev(`(() => {
  const s = window.getSelection();
  if (!s || !s.anchorNode) return { none: true };
  const node = s.anchorNode;
  const text = node.nodeType === 3 ? node.textContent : (node.textContent || '').slice(0, 20);
  return {
    nodeType: node.nodeType,
    parentClass: node.parentElement ? node.parentElement.className : '',
    offset: s.anchorOffset,
    fragment: (text || '').slice(0, 24),
    selected: s.toString().slice(0, 30),
  };
})()`)
  )
)

// 光标点是否落在行首：用 caretRangeFromPoint 探测
console.log(
  JSON.stringify(
    await ev(`(() => {
  const p = document.caretPositionFromPoint ? document.caretPositionFromPoint(400, 90) : null;
  if (!p) return { unsupported: true };
  return { offset: p.offset, text: (p.offsetNode.textContent || '').slice(0, 24), parent: p.offsetNode.parentElement?.className };
})()`)
  )
)
ws.close()
