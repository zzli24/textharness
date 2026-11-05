/**
 * 状态栏更新芯片的状态机测试。
 *
 * 运行：node scripts/test-updatechip.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const outfile = resolve(root, '.tmp/update-chip.bundle.cjs')
await build({
  entryPoints: [resolve(root, 'src/renderer/src/updateChip.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  logLevel: 'error',
})

const { initialChip, applyUpdateEvent, applyStall, chipAction, STALL_MS, DOWNLOAD_PAGE } =
  createRequire(import.meta.url)(outfile)

let passed = 0
const failures = []
function check(name, condition, extra = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${extra ? `（${extra}）` : ''}`)
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

console.log('\n更新芯片状态机')

const base = initialChip()
check('初始状态是隐藏的', base.visible === false && base.mode === 'none')
check('初始点击动作是「检查更新」', chipAction(base) === 'recheck')

const available = applyUpdateEvent(base, { kind: 'available', version: '0.4.6' }, 1000)
check('发现新版本后可见', available.visible === true && available.mode === 'available')
check('文案带版本号', available.label === '新版本 v0.4.6')
check('有新版本时点击打开下载页', chipAction(available) === 'open-download')

const downloading = applyUpdateEvent(available, { kind: 'progress', percent: 42 }, 2000)
check('进度事件更新百分比', downloading.mode === 'downloading' && downloading.label === '下载中 42%')
check('下载中点击也打开下载页', chipAction(downloading) === 'open-download')

const ready = applyUpdateEvent(downloading, { kind: 'downloaded', version: '0.4.6' }, 3000)
check('下载完成后提示重启', ready.mode === 'ready' && ready.label === '重启更新 v0.4.6')
check('下载完成后点击是安装', chipAction(ready) === 'install')

const manual = applyUpdateEvent(base, { kind: 'manual', version: '0.4.6', url: 'http://x/download' }, 4000)
check('macOS 手动模式保留地址', manual.mode === 'manual' && manual.url === 'http://x/download')
check('手动模式点击打开下载页', chipAction(manual) === 'open-download')

const failed = applyUpdateEvent(downloading, { kind: 'error', message: 'network down' }, 5000)
check('失败时给出可点击的手动出口', failed.mode === 'failed' && /失败/.test(failed.label))
check('失败提示里带原因', failed.title.includes('network down'))
check('失败时点击打开下载页', chipAction(failed) === 'open-download')

const none = applyUpdateEvent(available, { kind: 'none' }, 6000)
check('没有更新时隐藏', none.visible === false && none.mode === 'none')
check('没有更新时点击回到检查', chipAction(none) === 'recheck')

check('下载刚开始不会误判卡住', applyStall(downloading, 2000 + STALL_MS - 1).mode === 'downloading')
const stalled = applyStall(downloading, 2000 + STALL_MS + 1)
check('超过阈值转为「下载较慢」', stalled.mode === 'stalled' && /手动下载/.test(stalled.label))
check('卡住时点击打开下载页', chipAction(stalled) === 'open-download')
check('已完成状态不受卡住检测影响', applyStall(ready, 99999999).mode === 'ready')

check('默认下载地址可用', DOWNLOAD_PAGE.startsWith('http'))

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
