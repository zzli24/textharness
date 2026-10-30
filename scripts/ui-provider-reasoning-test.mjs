const PORT = process.env.CDP_PORT ?? '9560'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await call('Page.bringToFront')
await sleep(1000)

/* 1. 设置面板：服务商与推理等级 */
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true,cancelable:true}))`)
await sleep(900)
console.log(
  '服务商选项:',
  JSON.stringify(await ev(`(() => {
    const sel = [...document.querySelectorAll('.overlay .modal select')].find(s => s.options.length === 8);
    return sel ? [...sel.options].map(o => o.textContent).slice(0, 3).concat(['…']) : null;
  })()`))
)
console.log(
  '切换前:',
  JSON.stringify(await ev(`(() => {
    const sels = [...document.querySelectorAll('.overlay .modal select')];
    const prov = sels.find(s => s.options.length === 8);
    const base = [...document.querySelectorAll('.overlay .modal input[type=text]')].pop();
    return { provider: prov?.selectedIndex, base: base?.value };
  })()`))
)
await ev(`(() => {
  const prov = [...document.querySelectorAll('.overlay .modal select')].find(s => s.options.length === 8);
  prov.value = '1'; prov.dispatchEvent(new Event('change', { bubbles: true }));
  return 1
})()`)
await sleep(300)
console.log(
  '选「阿里云百炼」后:',
  JSON.stringify(await ev(`(() => {
    const inputs = [...document.querySelectorAll('.overlay .modal input')];
    const base = inputs.find(i => (i.placeholder || '').includes('deepseek.com') && i.type === 'text');
    const model = inputs.find(i => i.placeholder === 'deepseek-chat' || i.value.includes('qwen') || i.placeholder.includes('qwen'));
    return { base: base?.value ?? '(未找到)', model: model?.value ?? '(未找到)' };
  })()`))
)
console.log(
  '推理等级选项:',
  JSON.stringify(await ev(`(() => {
    const sel = [...document.querySelectorAll('.overlay .modal select')].find(s => [...s.options].some(o => o.value === 'auto'));
    return sel ? [...sel.options].map(o => o.value + '=' + o.textContent).join(' | ') : null;
  })()`))
)
await ev(`document.querySelector('.overlay .modal .foot .btn')?.click()`)
await sleep(400)

/* 2. 推理等级是否被网关接受 */
console.log('--- 推理等级 high 实测 ---')
await ev(`window.th.config.patch({ llmReasoning: 'high' })`)
await sleep(400)
console.log('当前配置:', JSON.stringify(await ev(`window.th.config.get().then(c => ({ reasoning: c.llmReasoning, base: c.llmBaseUrl }))`)))
await ev(`(() => {
  const input = document.getElementById('ai-input');
  input.value = '只回一句：推理等级测试';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('ai-send').click();
  return 1
})()`)
for (let i = 0; i < 60; i += 1) {
  const done = await ev(`document.getElementById('ai-stop').hidden`)
  if (done) break
  await sleep(500)
}
const reply = await ev(`(() => {
  const msgs = [...document.querySelectorAll('#ai-messages .msg.assistant')];
  return msgs.length ? msgs[msgs.length - 1].innerText.slice(-150) : '';
})()`)
console.log('回复:', JSON.stringify(reply))
console.log('是否 400:', String(reply).includes('400'))
await ev(`window.th.config.patch({ llmReasoning: 'auto' })`)
ws.close()
