const PORT = process.env.CDP_PORT ?? '9370'
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
  if (r.exceptionDetails) return { ERROR: r.exceptionDetails.text }
  return r.result?.value
}

await call('Page.bringToFront')
console.log('当前模型徽标:', await ev(`document.getElementById('ai-model').textContent`))

await ev(`document.getElementById('ai-model').click(); 1`)
await new Promise((r) => setTimeout(r, 1500))
console.log('菜单可见:', await ev(`!document.getElementById('ai-model-menu').hidden`))
console.log('模型总数:', await ev(`document.querySelectorAll('#model-list .model-item').length`))
console.log('前 5 个:', await ev(`[...document.querySelectorAll('#model-list .model-item span:first-child')].slice(0,5).map(s=>s.textContent)`))
console.log('当前项高亮:', await ev(`document.querySelector('#model-list .model-item.current')?.textContent ?? '无'`))

await ev(`(() => { const f = document.getElementById('model-filter'); f.value='flash'; f.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await new Promise((r) => setTimeout(r, 300))
console.log('过滤 flash 后:', await ev(`[...document.querySelectorAll('#model-list .model-item span:first-child')].map(s=>s.textContent)`))

await ev(`(() => {
  const items = [...document.querySelectorAll('#model-list .model-item')];
  const target = items.find(i => i.textContent.includes('deepseek-v4-flash')) ?? items[0];
  target.click();
  return target.textContent;
})()`)
await new Promise((r) => setTimeout(r, 800))
console.log('切换后徽标:', await ev(`document.getElementById('ai-model').textContent`))
const cfg = await ev(`window.th.config.get().then(c => c.llmModel)`)
console.log('已写入配置 llmModel:', cfg)
console.log('菜单已关闭:', await ev(`document.getElementById('ai-model-menu').hidden`))
ws.close()
