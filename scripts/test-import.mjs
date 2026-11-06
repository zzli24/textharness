/**
 * 导入 / 备份服务测试。
 *
 * 运行：node scripts/test-import.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'

const root = process.cwd()
const tmp = resolve(root, '.tmp/import-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/main/services/importer.ts'), resolve(root, 'src/main/services/backup.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outdir: resolve(tmp, 'bundle'),
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  logLevel: 'error',
})

const importer = createRequire(import.meta.url)(resolve(tmp, 'bundle/importer.cjs'))
const backup = createRequire(import.meta.url)(resolve(tmp, 'bundle/backup.cjs'))

let passed = 0
const failures = []
function check(name, ok, extra = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${extra ? `（${extra}）` : ''}`)
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

const src = join(tmp, 'source')
mkdirSync(join(src, 'sub'), { recursive: true })
mkdirSync(join(src, 'img'), { recursive: true })
writeFileSync(join(src, 'a.md'), '# A\n\n正文\n')
writeFileSync(join(src, 'sub', 'b.md'), '# B\n')
writeFileSync(join(src, 'img', 'pic.png'), Buffer.from([137, 80, 78, 71]))
const ws = join(tmp, 'ws')
mkdirSync(ws, { recursive: true })

const r1 = await importer.importNotes({ source: 'markdown', inputPath: src, workspaceRoot: ws })
check('Markdown 文件夹导入', r1.ok && r1.imported === 2, JSON.stringify(r1))
check('保留子目录结构', existsSync(join(r1.targetDir, 'sub', 'b.md')))
check('图片附件一起复制', existsSync(join(r1.targetDir, 'img', 'pic.png')))

const enex = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
<note>
<title>测试笔记</title>
<content><![CDATA[<?xml version="1.0"?><en-note><h1>标题</h1><p>正文 <b>加粗</b></p></en-note>]]></content>
<resource><data encoding="base64">aGVsbG8=</data><mime>text/plain</mime><resource-attributes><file-name>说明.txt</file-name></resource-attributes></resource>
</note>
</en-export>`
const enexPath = join(tmp, 'test.enex')
writeFileSync(enexPath, enex, 'utf8')
const r2 = await importer.importNotes({ source: 'enex', inputPath: enexPath, workspaceRoot: ws })
check('Evernote .enex 导入', r2.ok && r2.imported === 1, JSON.stringify(r2))
const enexMd = readFileSync(join(r2.targetDir, '测试笔记.md'), 'utf8')
check('ENEX 正文转 Markdown', enexMd.includes('# 标题') && enexMd.includes('**加粗**'))
check('ENEX 附件落盘', existsSync(join(r2.targetDir, '_attachments', '说明.txt')))

const zipPath = join(tmp, 'backup.zip')
const b = await backup.createBackup(ws, zipPath)
check('备份生成 zip', b.ok && b.files > 0 && existsSync(zipPath), JSON.stringify(b))
const ws2 = join(tmp, 'ws2')
mkdirSync(ws2, { recursive: true })
const restore = await backup.restoreBackup(zipPath, ws2)
check('恢复文件数一致', restore.ok && restore.restored > 0, JSON.stringify(restore))
check('恢复出笔记文件', existsSync(join(ws2, '导入')))

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
rmSync(tmp, { recursive: true, force: true })
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
