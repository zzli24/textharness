/**
 * 模型参数差异测试：max_tokens / max_completion_tokens、temperature 兼容。
 *
 * 运行：node scripts/test-modelparams.mjs
 */
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const outfile = resolve(root, '.tmp/model-params.bundle.cjs')
await build({
  entryPoints: [resolve(root, 'src/main/services/modelParams.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  logLevel: 'error',
})

const requireCjs = createRequire(import.meta.url)
const { paramsFor, tokenParams, noteParamError, reasoningEffortFor, resetParamOverrides, setParamCacheFile } = requireCjs(outfile)

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

console.log('\n模型参数兼容')

resetParamOverrides()

/* ---------- 按模型名初判 ---------- */
check('o3-mini 用 max_completion_tokens', paramsFor('o3-mini').tokenField === 'max_completion_tokens')
check('o3-mini 不带 temperature', paramsFor('o3-mini').temperature === false)
check('o1 系列也走新字段', paramsFor('o1').tokenField === 'max_completion_tokens')
check('gpt-5 走新字段', paramsFor('gpt-5').tokenField === 'max_completion_tokens')
check('gpt-4.1 走新字段', paramsFor('gpt-4.1').tokenField === 'max_completion_tokens')
check('deepseek-chat 用 max_tokens', paramsFor('deepseek-chat').tokenField === 'max_tokens')
check('deepseek-chat 允许 temperature', paramsFor('deepseek-chat').temperature === true)
check('未知模型默认 max_tokens', paramsFor('some-relay-model').tokenField === 'max_tokens')
check('gpt-6-sol 初判就带 none', paramsFor('gpt-6-sol').reasoningEffort === 'none')
check('gpt-6 之外不预置 none', paramsFor('gpt-5').reasoningEffort === undefined)

/* ---------- 生成请求字段 ---------- */
const dsFields = tokenParams('deepseek-chat', 1024)
check('旧模型带 max_tokens + temperature', dsFields.max_tokens === 1024 && dsFields.temperature === 0.2)
check('旧模型不带 max_completion_tokens', !('max_completion_tokens' in dsFields))

const oFields = tokenParams('o4-mini', 2048)
check('新模型带 max_completion_tokens', oFields.max_completion_tokens === 2048)
check('新模型不带 max_tokens / temperature', !('max_tokens' in oFields) && !('temperature' in oFields))

/* ---------- 从报错里学习 ---------- */
const msgTokens =
  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
check('识别 max_tokens 报错', noteParamError('relay-a', msgTokens) === true)
const learned = tokenParams('relay-a', 512)
check('学会后用 max_completion_tokens', learned.max_completion_tokens === 512 && !('max_tokens' in learned))

const msgTemp = "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."
check('识别 temperature 报错', noteParamError('relay-b', msgTemp) === true)
const tempFixed = tokenParams('relay-b', 512)
check('学会后不再带 temperature', !('temperature' in tempFixed) && tempFixed.max_tokens === 512)

check('无关的 400 不误判', noteParamError('relay-c', 'HTTP 400：invalid request: messages is required') === false)
check('未学习过的模型不受影响', tokenParams('relay-d', 128).max_tokens === 128)

/* 反向报文：中转只认老字段 */
const reversed =
  "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead."
check('识别反向报文', noteParamError('relay-e', reversed) === true)
check('反向报文后改用 max_tokens', tokenParams('relay-e', 64).max_tokens === 64)

/* reasoning_effort：带工具时被拒（gpt-6-sol 等） */
const msgReasoning =
  'Function tools with reasoning_effort are not supported for gpt-6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to \'none\'.'
check('识别 reasoning_effort 报错', noteParamError('gpt-6-sol', msgReasoning) === true)
check('重复识别不再返回 true', noteParamError('gpt-6-sol', msgReasoning) === false)
check('reasoningEffortFor 会发出 none', reasoningEffortFor('gpt-6-sol', 'auto') === 'none')
check('学会后强制 reasoning_effort=none', paramsFor('gpt-6-sol').reasoningEffort === 'none')
check('其它模型不受影响', paramsFor('deepseek-reasoner').reasoningEffort === undefined)

resetParamOverrides()
/* ---------- 学习结果落盘 ---------- */
const cacheDir = resolve(root, '.tmp/param-cache-test')
mkdirSync(cacheDir, { recursive: true })
const cacheFile = resolve(cacheDir, 'model-params.json')
try {
  rmSync(cacheFile, { force: true })
} catch {
  /* 忽略 */
}
resetParamOverrides()
setParamCacheFile(cacheFile)
noteParamError('cached-model', "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")
check('学到的结论写进缓存文件', existsSync(cacheFile) && readFileSync(cacheFile, 'utf8').includes('cached-model'))

resetParamOverrides()
setParamCacheFile(cacheFile)
check('重开（重新加载缓存）后仍然生效', paramsFor('cached-model').tokenField === 'max_completion_tokens')

resetParamOverrides()
setParamCacheFile(resolve(cacheDir, '不存在.json'))
check('缓存文件不存在也不报错', paramsFor('cached-model').tokenField === 'max_tokens')
resetParamOverrides()
check('重置后回到初判', paramsFor('relay-a').tokenField === 'max_tokens')

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
