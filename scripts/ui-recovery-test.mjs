const PORT = process.env.CDP_PORT
const PHASE = process.env.PHASE ?? 'A'

// 等页面出现（避免固定 sleep）
let page = null
for (let i = 0; i < 200; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
    if (page) break
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 200))
}
if (!page) {
  console.log('页面没起来')
  process.exit(1)
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
const tabs = () => ev(`[...document.querySelectorAll('.tab .title')].map(t => t.textContent)`)
const toastText = () => ev(`document.getElementById('toast')?.textContent ?? ''`)
const activeText = () => ev(`document.querySelector('.cm-content')?.innerText ?? ''`)

await call('Page.bringToFront')
await sleep(600)

if (PHASE === 'B') {
  // 崩溃提示是 3.2 秒的 toast，尽快抓
  let seen = ''
  for (let i = 0; i < 12; i += 1) {
    const text = await ev(`document.querySelector('.toast')?.textContent ?? ''`)
    if (text) {
      seen = text
      break
    }
    await sleep(250)
  }
  console.log('B 崩溃提示:', JSON.stringify(seen))
}

if (PHASE === 'A') {
  // 打开一个文件 + 建一个未命名文档写点东西
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',ctrlKey:true,bubbles:true,cancelable:true}))`)
  await sleep(700)
  await ev(`(() => { const i = [...document.querySelectorAll('.overlay .modal')].pop().querySelector('input[type=text]'); i.value='索引使用建议'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
  await sleep(300)
  await ev(`document.querySelector('.quick-item')?.click()`)
  await sleep(900)
  console.log('A 已打开:', JSON.stringify(await tabs()))

  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`)
  await sleep(500)
  await ev(`document.querySelector('.cm-content').focus()`)
  await call('Input.insertText', { text: 'RECOVER-ME-12345 这段没保存' })
  await sleep(300)
  console.log('A 标签:', JSON.stringify(await tabs()))
  console.log('A 等待快照（11 秒）…')
  await sleep(11000)
  console.log('A 完成，可以强杀')
}

if (PHASE === 'B') {
  console.log('B 标签:', JSON.stringify(await tabs()))
  console.log('B 当前文档含 RECOVER:', (await activeText()).includes('RECOVER-ME-12345'))
  const dirtyCount = () =>
    ev(`[...document.querySelectorAll('.tab .title')].filter(t => t.textContent.startsWith('●')).length`)
  console.log('B 脏标签数:', await dirtyCount())

  // 保存成正式文件，让状态变干净
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}))`)
  await sleep(1800)
  console.log('B 保存后标签:', JSON.stringify(await tabs()))
  const left = await dirtyCount()
  console.log('B 保存后脏标签数:', left)

  if (left === 0) {
    console.log('B 干净退出中…')
    await ev(`window.close()`)
  } else {
    console.log('B 仍有未保存标签，跳过退出测试')
  }
}

if (PHASE === 'C') {
  let seen = ''
  for (let i = 0; i < 10; i += 1) {
    const text = await ev(`document.querySelector('.toast')?.textContent ?? ''`)
    if (text) {
      seen = text
      break
    }
    await sleep(250)
  }
  console.log('C 标签:', JSON.stringify(await tabs()))
  console.log('C 提示（正常退出应为空）:', JSON.stringify(seen))
}
ws.close()
