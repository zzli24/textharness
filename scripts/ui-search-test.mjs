import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.CDP_PORT ?? '9460'
const WS = process.env.TH_WS

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const shortcut = async (key, shift = false) => {
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,shiftKey:${shift},bubbles:true,cancelable:true}))`)
  await sleep(700)
}

const modalScope = `[...document.querySelectorAll('.overlay .modal')].pop()`
const inputAt = (index) =>
  `${modalScope}.querySelectorAll('input[type=text]')[${index}]`
const clickFoot = (label) =>
  `(() => { const b = [...${modalScope}.querySelectorAll('.foot .btn')].find(x=>x.textContent===${JSON.stringify(label)}); if(!b) return false; b.click(); return true })()`

await call('Page.bringToFront')
await sleep(400)

/* 1. 快速打开 */
console.log('=== Ctrl+P 快速打开 ===')
await shortcut('P')
console.log('弹窗标题:', await ev(`document.querySelector('.overlay .modal h2')?.textContent`))
console.log('文件总数:', await ev(`document.querySelectorAll('.quick-item').length`))
await ev(`(() => { const i = ${inputAt(0)}; i.value='索引'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await sleep(300)
console.log('过滤后:', await ev(`[...document.querySelectorAll('.quick-item')].map(e=>e.textContent).slice(0,5)`))

/* 2. 文件夹搜索 */
console.log('=== Ctrl+Shift+F 文件夹搜索 ===')
await shortcut('F', true)
console.log('弹窗标题:', await ev(`document.querySelector('.overlay .modal h2')?.textContent`))
console.log('弹窗数量:', await ev(`document.querySelectorAll('.overlay .modal').length`))
await ev(`(() => { const i = ${inputAt(0)}; i.value='索引'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await ev(clickFoot('查找全部'))
await sleep(1800)
console.log('状态:', await ev(`document.querySelector('.search-status')?.textContent`))
console.log('命中条数:', await ev(`document.querySelectorAll('.search-hit').length`))
console.log('前 3 条:', await ev(`[...document.querySelectorAll('.search-hit')].slice(0,3).map(e=>e.textContent.slice(0,60))`))

/* 3. 点击结果跳转 */
await ev(`document.querySelector('.search-hit')?.click()`)
await sleep(900)
console.log('跳转后活动标签:', await ev(`document.querySelector('.tab.active .title')?.textContent`))
console.log('光标行:', await ev(`[...document.querySelectorAll('.cm-cursor')].length > 0 ? '已定位' : '无光标'`))

/* 4. 替换 */
console.log('=== 全部替换 ===')
const target = join(WS, '_replace_test.txt')
await ev(`(async () => { await window.th.fs.write(${JSON.stringify(target)}, 'foo bar foo\\nsecond foo line\\n', {encoding:'utf8',bom:false,eol:'lf'}, false); return 1 })()`)
await shortcut('F', true)
await ev(`(() => {
  const i0 = ${inputAt(0)}; i0.value='foo'; i0.dispatchEvent(new Event('input',{bubbles:true}));
  const i1 = ${inputAt(1)}; i1.value='BAR'; i1.dispatchEvent(new Event('input',{bubbles:true}));
  return 1
})()`)
await ev(clickFoot('查找全部'))
await sleep(1800)
console.log('搜索状态:', await ev(`document.querySelector('.search-status')?.textContent`))
await ev(clickFoot('全部替换'))
await sleep(600)
console.log('确认框:', await ev(`document.querySelector('.overlay .modal .confirm-message')?.textContent`))
await ev(clickFoot('开始替换'))
await sleep(2000)
console.log('替换状态:', await ev(`document.querySelector('.search-status')?.textContent`))
console.log('文件内容:', JSON.stringify(readFileSync(target, 'utf8')))
const historyDir = join(WS, '.history')
console.log('有备份目录:', existsSync(historyDir), existsSync(historyDir) ? readdirSync(historyDir) : [])
ws.close()
