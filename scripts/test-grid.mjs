/**
 * 表格视图纯逻辑测试：排序 / 类型推断 / 合并区间 / 撤销栈 / 行列操作。
 *
 * 运行：node scripts/test-grid.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const outfile = resolve(root, '.tmp/grid-model.bundle.cjs')
await build({
  entryPoints: [resolve(root, 'src/renderer/src/gridModel.ts')],
  bundle: true,
  platform: 'neutral',
  format: 'cjs',
  target: 'es2020',
  outfile,
  logLevel: 'error',
})

const requireCjs = createRequire(import.meta.url)
const model = requireCjs(outfile)

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n表格模型')

/* ---------- 类型推断 ---------- */
check('整数列识别为 number', model.detectCellKind(['1', '20', '3']) === 'number')
check('小数与负数也是 number', model.detectCellKind(['-1.5', '2.25', '0']) === 'number')
check('日期列识别为 date', model.detectCellKind(['2026-11-04', '2026-01-02 09:30']) === 'date')
check('混了文字就是 text', model.detectCellKind(['1', 'abc']) === 'text')
check('空值不参与类型判断', model.detectCellKind(['', '  ', '5']) === 'number')

/* ---------- 排序 ---------- */
const table = [
  ['name', 'count', 'date'],
  ['b', '10', '2026-11-02'],
  ['a', '2', '2026-11-04'],
  ['c', '', '2026-10-30'],
  ['d', '2', '2026-11-01'],
]

const ascCount = model.sortRows(table, [{ col: 1, dir: 'asc' }], true)
check('表头保持第一行', eq(ascCount[0], ['name', 'count', 'date']))
check('数字按大小排（不是字典序）', eq(ascCount.slice(1).map((r) => r[0]), ['a', 'd', 'b', 'c']))
check('空值排最后', ascCount[ascCount.length - 1][0] === 'c')

const descCount = model.sortRows(table, [{ col: 1, dir: 'desc' }], true)
check('降序时空值仍然最后', eq(descCount.slice(1).map((r) => r[0]), ['b', 'a', 'd', 'c']))

const byDate = model.sortRows(table, [{ col: 2, dir: 'asc' }], true)
check('日期按时间排', eq(byDate.slice(1).map((r) => r[0]), ['c', 'd', 'b', 'a']))

const multi = model.sortRows(
  [
    ['g', 'n'],
    ['x', '2'],
    ['y', '1'],
    ['a', '2'],
    ['b', '1'],
  ],
  [
    { col: 1, dir: 'asc' },
    { col: 0, dir: 'asc' },
  ],
  true
)
check('多列排序：先按 n 再按 g', eq(multi.slice(1).map((r) => r[0]), ['b', 'y', 'a', 'x']))

const stable = model.sortRows(
  [
    ['k', 'v'],
    ['first', '1'],
    ['second', '1'],
    ['third', '1'],
  ],
  [{ col: 1, dir: 'asc' }],
  true
)
check('相等值保持原顺序（稳定）', eq(stable.slice(1).map((r) => r[0]), ['first', 'second', 'third']))

const noHeader = model.sortRows(
  [
    ['3', 'c'],
    ['1', 'a'],
  ],
  [{ col: 0, dir: 'asc' }],
  false
)
check('无表头时所有行参与排序', eq(noHeader.map((r) => r[1]), ['a', 'c']))

const emptyKeys = model.sortRows(table, [], true)
check('没有排序键时原样返回', eq(emptyKeys, table) && emptyKeys !== table)

/* ---------- 合并区间 ---------- */
const spans = model.mergeSpans(['a', 'a', 'b', 'b', 'b', '', '', 'c'])
check('相邻相同值合并成区间', eq(spans, [{ start: 0, span: 2 }, { start: 2, span: 3 }]))
check('空值不合并', model.mergeSpans(['', '', 'x']).length === 0)
check('单个值不算合并', model.mergeSpans(['x', 'y']).length === 0)

/* ---------- 撤销栈 ---------- */
const history = new model.GridHistory(3)
check('初始不能撤销/重做', history.canUndo === false && history.canRedo === false)

history.push([['1']])
check('压栈后可撤销', history.canUndo === true)

const undone = history.undo([['2']])
check('撤销回到快照', eq(undone, [['1']]))
check('撤销后可重做', history.canRedo === true)

const redone = history.redo([['1']])
check('重做回到撤销前', eq(redone, [['2']]))
check('重做之后还能再撤销', history.canUndo === true && eq(history.undo([['2']]), [['1']]))

history.push([['a']])
history.push([['b']])
history.undo([['c']])
history.push([['d']])
check('压栈清空重做栈', history.canRedo === false)

const limited = new model.GridHistory(2)
limited.push([['1']])
limited.push([['2']])
limited.push([['3']])
limited.undo([['4']])
limited.undo([['3']])
check('超过上限丢弃最老的记录', limited.canUndo === false)

/* ---------- 行列操作 ---------- */
check('插入行', eq(model.insertRow([['a', 'b'], ['c', 'd']], 1), [['a', 'b'], ['', ''], ['c', 'd']]))
check('删除行', eq(model.removeRowAt([['a'], ['b']], 0), [['b']]))
check('只剩一行时不允许删', model.removeRowAt([['a']], 0).length === 1)
check('插入列', eq(model.insertColumn([['a', 'b']], 1), [['a', '', 'b']]))
check('删除列', eq(model.removeColumnAt([['a', 'b'], ['c', 'd']], 0), [['b'], ['d']]))
check('只剩一列时不允许删', eq(model.removeColumnAt([['a']], 0), [['a']]))
check('列区间（正向）', eq(model.columnRange(1, 3), [1, 2, 3]))
check('列区间（反向）', eq(model.columnRange(3, 1), [1, 2, 3]))

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
