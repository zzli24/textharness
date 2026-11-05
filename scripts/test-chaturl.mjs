/**
 * Base URL 处理测试（含 Responses API 地址的明确提示）。
 *
 * 运行：node scripts/test-chaturl.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
mkdirSync(resolve(root, '.tmp'), { recursive: true })

const outfile = resolve(root, '.tmp/chat-url.bundle.cjs')
await build({
  entryPoints: [resolve(root, 'src/main/services/chatUrl.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  logLevel: 'error',
})

const { trimBaseUrl, isResponsesApiBase, chatCompletionsUrl, resolveChatCompletionsUrl } = createRequire(import.meta.url)(outfile)

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

console.log('\nBase URL 处理')

check('去掉结尾斜杠', trimBaseUrl('https://api.deepseek.com/v1///') === 'https://api.deepseek.com/v1')
check('普通地址拼 chat/completions', chatCompletionsUrl('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions')
check(
  '带斜杠的地址不会拼出双斜杠',
  chatCompletionsUrl('https://ai.pocketcity.com/v1/') === 'https://ai.pocketcity.com/v1/chat/completions'
)
check('识别 /responses 地址', isResponsesApiBase('https://ai.pocketcity.com/v1/responses') === true)
check('/responses/ 也识别', isResponsesApiBase('https://ai.pocketcity.com/v1/responses/') === true)
check('普通 /v1 不算 responses', isResponsesApiBase('https://ai.pocketcity.com/v1') === false)

let message = ''
try {
  resolveChatCompletionsUrl('https://ai.pocketcity.com/v1/responses')
} catch (err) {
  message = err instanceof Error ? err.message : String(err)
}
check('responses 地址给出明确错误', /Responses API/.test(message), message)
check('错误里给出可用的替换地址', message.includes('https://ai.pocketcity.com/v1') && !message.includes('/responses 就能'), message)

check(
  '正常地址直接返回可用 URL',
  resolveChatCompletionsUrl('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions'
)

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
