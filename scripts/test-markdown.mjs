/**
 * Markdown 渲染单元测试（重点是表格）。
 *
 * 运行：node scripts/test-markdown.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const outfile = resolve(root, '.tmp/markdown.bundle.cjs')
await build({
  entryPoints: [resolve(root, 'src/renderer/src/markdown.ts')],
  bundle: true,
  platform: 'neutral',
  format: 'cjs',
  target: 'es2020',
  outfile,
  logLevel: 'error',
})

const requireCjs = createRequire(import.meta.url)
const { renderMarkdown } = requireCjs(outfile)

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

console.log('\nMarkdown 表格渲染')

const simple = renderMarkdown(['| 名称 | 数量 |', '| --- | --- |', '| 苹果 | 3 |', '| 香蕉 | 5 |'].join('\n'))
check('渲染出表格容器', simple.includes('class="md-table-wrap"'))
check('表头用 th', simple.includes('<th>名称</th>') && simple.includes('<th>数量</th>'))
check('表体用 td', simple.includes('<td>苹果</td>') && simple.includes('<td>5</td>'))
check('带复制按钮', simple.includes('class="md-table-copy"'))
check('两行表体', (simple.match(/<tr>/g) ?? []).length === 3)

const aligned = renderMarkdown(['| 左 | 中 | 右 |', '| :-- | :-: | --: |', '| a | b | c |'].join('\n'))
check('左对齐', aligned.includes('<td class="al-left">a</td>'))
check('居中', aligned.includes('<td class="al-center">b</td>'))
check('右对齐', aligned.includes('<td class="al-right">c</td>'))

const escaped = renderMarkdown(['| 字段 | 说明 |', '| --- | --- |', '| a | x \\| y |'].join('\n'))
check('转义竖线不拆列', escaped.includes('<td>x | y</td>'))
check('转义后仍只有两列', (escaped.match(/<td/g) ?? []).length === 2)

const inline = renderMarkdown(['| 命令 | 作用 |', '| --- | --- |', '| `npm run dev` | **开发**模式 |'].join('\n'))
check('单元格内行内代码', inline.includes('<code>npm run dev</code>'))
check('单元格内加粗', inline.includes('<strong>开发</strong>'))

const shortRow = renderMarkdown(['| a | b | c |', '| --- | --- | --- |', '| 1 |'].join('\n'))
check('短行补齐列数', (shortRow.match(/<td/g) ?? []).length === 3)

const notTable = renderMarkdown('用 | 分隔的普通文字\n没有分隔行')
check('没有分隔行不当作表格', !notTable.includes('md-table-wrap') && notTable.includes('<p>'))

const mixed = renderMarkdown(
  ['## 标题', '', '| k | v |', '| --- | --- |', '| a | 1 |', '', '表格后面的段落'].join('\n')
)
check('表格前后内容都在', mixed.includes('<h3>标题</h3>') && mixed.includes('表格后面的段落'))
check('表格后段落没被吞进表体', (mixed.match(/<td/g) ?? []).length === 2)

const codeOnly = renderMarkdown(['```sql', 'select 1;', '```'].join('\n'))
check('代码块仍然正常', codeOnly.includes('class="code-card"') && codeOnly.includes('select 1;'))

const pipeInCode = renderMarkdown(['```', 'a | b', '| --- |', '```'].join('\n'))
check('代码块里的表格语法不渲染', !pipeInCode.includes('md-table-wrap'))

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
