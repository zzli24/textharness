#!/usr/bin/env node
// 只更新官网文案时用：拿 site/downloads/meta.json 里的版本/大小/哈希渲染模板，
// 不动安装包、不跑 CI。
//
//   node scripts/render-site.mjs            # 渲染到 .tmp/site-rendered.html
//   node scripts/render-site.mjs --deploy   # 顺便 scp 到生产机
//
// meta.json 由 scripts/release.mjs 在发版时写入。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const metaPath = join(ROOT, 'site/downloads/meta.json')
if (!existsSync(metaPath)) {
  console.error(`缺少 ${metaPath}（发版时由 release.mjs 生成）`)
  process.exit(1)
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const template = readFileSync(join(ROOT, 'site/index.html'), 'utf8')
const rendered = template
  .replaceAll('{{VERSION}}', meta.version)
  .replaceAll('{{EXE_SIZE}}', meta.exe.size)
  .replaceAll('{{EXE_SHA}}', meta.exe.sha)
  .replaceAll('{{ARM_SIZE}}', meta.arm.size)
  .replaceAll('{{ARM_SHA}}', meta.arm.sha)
  .replaceAll('{{X64_SIZE}}', meta.x64.size)
  .replaceAll('{{X64_SHA}}', meta.x64.sha)

const leftover = /\{\{[A-Z_]+\}\}/.exec(rendered)
if (leftover) {
  console.error(`还有没替换的占位符: ${leftover[0]}`)
  process.exit(1)
}

const outPath = join(ROOT, '.tmp/site-rendered.html')
writeFileSync(outPath, rendered, 'utf8')
console.log(`渲染完成 → ${outPath}（v${meta.version}）`)

if (process.argv.includes('--deploy')) {
  const HOST = process.env.DEPLOY_HOST || 'root@47.109.100.9'
  const KEY = join(ROOT, process.env.DEPLOY_KEY || 'deploy/keys/deploy_ed25519')
  execFileSync('scp', ['-i', KEY, '-o', 'BatchMode=yes', outPath, `${HOST}:/var/www/textharness/index.html`], {
    stdio: 'inherit',
  })
  console.log('已部署 http://47.109.100.9/')
}
