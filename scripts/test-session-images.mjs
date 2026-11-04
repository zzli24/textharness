/**
 * 会话图片落盘/还原的单元测试。
 * 运行：node scripts/test-session-images.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const tmp = resolve(root, '.tmp')
mkdirSync(tmp, { recursive: true })
const outfile = resolve(tmp, 'svc-sessions.cjs')
rmSync(resolve(tmp, 'agent-test-userdata', 'sessions'), { recursive: true, force: true })
rmSync(resolve(tmp, 'agent-test-userdata', 'session-images'), { recursive: true, force: true })

await build({
  entryPoints: [resolve(root, 'src/main/services/sessions.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  alias: {
    '@shared': resolve(root, 'src/shared'),
    electron: resolve(root, 'scripts/electron-stub.mjs'),
  },
  logLevel: 'error',
})

const sessions = createRequire(import.meta.url)(outfile)
let passed = 0
const failures = []
const check = (name, ok, extra = '') => {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

// 1x1 透明 PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

console.log('1) 带图消息保存后落成文件')
const id = 'session-test-1'
await sessions.saveSession({
  id,
  title: '带图会话',
  updatedAt: Date.now(),
  messages: [{ role: 'user', content: '看这张图', images: [PNG] }],
})
const dir = resolve(tmp, 'agent-test-userdata', 'session-images', id)
const files = existsSync(dir) ? readdirSync(dir) : []
check('图片文件已写出', files.length === 1, JSON.stringify(files))

console.log('2) 读回来还原成 data URL')
const loaded = await sessions.loadSession(id)
check('消息还在', loaded?.messages.length === 1)
const back = loaded?.messages[0]?.images?.[0] ?? ''
check('还原成 data URL', back.startsWith('data:image/png;base64,'), back.slice(0, 30))
check('内容一致', back === PNG)

console.log('3) 超大数据不落盘')
const huge = 'data:image/png;base64,' + 'A'.repeat(4_100_000)
await sessions.saveSession({
  id: 'session-test-2',
  title: '大图',
  updatedAt: Date.now(),
  messages: [{ role: 'user', content: '大图', images: [huge] }],
})
const loaded2 = await sessions.loadSession('session-test-2')
check('超大图被丢弃', loaded2?.messages[0]?.images === undefined)

console.log('4) 删除会话同时清图')
await sessions.deleteSession(id)
check('会话文件删了', !existsSync(resolve(tmp, 'agent-test-userdata', 'sessions', `${id}.json`)))
check('图片目录也清了', !existsSync(dir))

console.log('')
if (failures.length > 0) {
  console.log(`结果：${passed} 通过 / ${failures.length} 失败`)
  process.exit(1)
}
console.log(`结果：${passed} 通过 / 0 失败`)
