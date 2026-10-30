// 验证定时任务：手动触发 → 等待完成 → 检查「知识库」产物 + 原稿未被改动
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const PORT = process.env.CDP_PORT ?? '9343'
const WS_ROOT = process.env.WS_ROOT

function snapshot(dir, acc = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.tasks' || entry.name === '知识库' || entry.name === '.history') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) snapshot(full, acc)
    else if (entry.isFile()) {
      acc.set(relative(dir, full), createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  return acc
}

const before = snapshot(WS_ROOT)
console.log(`原稿 ${before.size} 个，已记录哈希`)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result)
    pending.delete(msg.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))

function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, { resolve }))
}

const evaluate = async (expression, awaitPromise = false) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result?.value
}

const tasks = await evaluate(`window.th.tasks.list()`, true)
console.log('任务列表:', JSON.stringify(tasks, null, 2))

await evaluate(`void window.th.tasks.run('draft-kb').catch(e => console.error(e))`, false)
console.log('已触发，等待后台整理…')

const started = Date.now()
let kbFiles = []
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  try {
    const kb = join(WS_ROOT, '知识库')
    if (statSync(kb).isDirectory()) {
      const walk = (dir) => {
        const out = []
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const f = join(dir, e.name)
          if (e.isDirectory()) out.push(...walk(f))
          else out.push(relative(WS_ROOT, f))
        }
        return out
      }
      kbFiles = walk(kb)
      if (kbFiles.length > 0) break
    }
  } catch {
    /* 还没生成 */
  }
  if (i % 5 === 0) process.stdout.write(`\r  等待中 ${Math.round((Date.now() - started) / 1000)}s`)
}
console.log(`\n耗时约 ${Math.round((Date.now() - started) / 1000)}s`)

const after = snapshot(WS_ROOT)
const changed = []
for (const [file, hash] of before) {
  if (after.get(file) !== hash) changed.push(file)
}
const added = [...after.keys()].filter((f) => !before.has(f))

console.log('\n=== 知识库产物 ===')
console.log(kbFiles.length ? kbFiles.join('\n') : '（没有生成）')
console.log('\n=== 原稿是否被改动 ===')
console.log(changed.length === 0 ? '✅ 没有任何原稿被修改' : `❌ 被改动：${changed.join(', ')}`)
console.log('新增的普通文件:', added.length ? added.join(', ') : '（无）')

const log = join(WS_ROOT, '.tasks', 'run.log')
try {
  console.log('\n=== 运行日志（最后 4 行）===')
  console.log(readFileSync(log, 'utf8').trim().split('\n').slice(-4).join('\n'))
} catch {
  console.log('（没有日志文件）')
}

ws.close()
