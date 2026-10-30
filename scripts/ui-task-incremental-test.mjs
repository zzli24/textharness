import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.CDP_PORT ?? '9590'
const WS_ROOT = process.env.TH_WS

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

const runTask = async () => {
  const started = Date.now()
  const res = await ev(`window.th.tasks.run('draft-kb').then(() => 'ok').catch(e => 'ERR: ' + String(e.message).slice(0, 120))`)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const last = await ev(`window.th.tasks.list().then(l => (l[0].lastResult || '').replace(/\\s+/g, ' ').slice(0, 90))`)
  return { res, seconds, last }
}

await call('Page.bringToFront')
await sleep(1000)

/* 1. 刚跑过：应立刻返回"没有新增" */
await ev(`(async () => {
  const cfg = await window.th.config.get();
  cfg.tasks[0].lastRunAt = Date.now();
  cfg.tasks[0].enabled = true;
  await window.th.config.patch({ tasks: cfg.tasks });
  return 1
})()`)
await sleep(300)
console.log('① 无新增时:', JSON.stringify(await runTask()))

/* 2. 造一个新草稿后再跑 */
const draft = join(WS_ROOT, '2026-10-29', '_incremental-test.md')
writeFileSync(draft, '# 增量测试草稿\n\nMySQL 的 EXPLAIN 里 type=ALL 表示全表扫描，要关注 rows 和 filtered。\n', 'utf8')
console.log('② 新增草稿后:', JSON.stringify(await runTask()))

/* 3. 只改 mtime，不改内容 */
const now = new Date()
rmSync(draft, { force: true })
await sleep(300)
console.log('③ 清理后（应无新增）:', JSON.stringify(await runTask()))
ws.close()
