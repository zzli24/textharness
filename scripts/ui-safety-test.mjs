import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.CDP_PORT ?? '9450'
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

const clickRow = async (name) => {
  const ok = await ev(`(() => {
    const row = [...document.querySelectorAll('.row')].find(r => r.textContent.trim().endsWith(${JSON.stringify(name)}));
    if (!row) return false;
    row.click();
    return true;
  })()`)
  await sleep(600)
  return ok
}

const modalState = () =>
  ev(`(() => {
    const box = document.querySelector('.overlay .modal');
    if (!box) return null;
    return {
      title: box.querySelector('h2')?.textContent,
      message: box.querySelector('.confirm-message')?.textContent,
      buttons: [...box.querySelectorAll('.foot .btn')].map(b => b.textContent),
    };
  })()`)

const clickModalButton = async (label) => {
  const ok = await ev(`(() => {
    const btn = [...document.querySelectorAll('.overlay .modal .foot .btn')].find(b => b.textContent === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  await sleep(500)
  return ok
}

const editorText = () => ev(`document.querySelector('.cm-content')?.innerText ?? ''`)
const tabTitles = () => ev(`[...document.querySelectorAll('.tab .title')].map(t => t.textContent)`)

await call('Page.bringToFront')
await sleep(500)

/* 1. 大文件 */
console.log('--- 大文件 ---')
console.log('点击 _test_big.txt:', await clickRow('_test_big.txt'))
await sleep(800)
console.log('弹窗:', JSON.stringify(await modalState()))
console.log('点「只读打开」:', await clickModalButton('只读打开'))
await sleep(1500)
console.log('当前标签:', JSON.stringify(await tabTitles()))
console.log('编辑器前 20 字:', JSON.stringify((await editorText()).slice(0, 20)))
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', modifiers: 2 })
await sleep(500)

/* 2. 外部修改 */
console.log('--- 外部修改 ---')
console.log('点击 _test_mod.txt:', await clickRow('_test_mod.txt'))
console.log('初始内容:', JSON.stringify(await editorText()))
writeFileSync(join(WS, '_test_mod.txt'), 'VERSION 2 from another program\n', 'utf8')
console.log('已从外部改写，等待监测…')
await sleep(5200)
console.log('弹窗:', JSON.stringify(await modalState()))
console.log('点「是」:', await clickModalButton('是'))
await sleep(600)
console.log('重新加载后:', JSON.stringify(await editorText()))

/* 3. 文件被删除 */
console.log('--- 文件删除 ---')
console.log('点击 _test_del.txt:', await clickRow('_test_del.txt'))
rmSync(join(WS, '_test_del.txt'), { force: true })
console.log('已删除，等待监测…')
await sleep(5200)
console.log('弹窗:', JSON.stringify(await modalState()))
console.log('点「保留内容」:', await clickModalButton('保留内容'))
console.log('标签仍在:', JSON.stringify(await tabTitles()))
ws.close()
