// 准备测试用的工作区与 user-data 配置（避免经由 PowerShell 传参导致中文乱码）
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const ws = join(root, '..', 'agent-ws')
const ud = join(root, '.tmp', 'ud13')

mkdirSync(join(ws, '2026-10-27'), { recursive: true })
mkdirSync(ud, { recursive: true })

writeFileSync(
  join(ws, '2026-10-27', '慢查询排查.sql'),
  `-- 慢查询排查：按平均耗时排序
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

-- TODO: 补一个按表维度聚合的版本
`,
  'utf8'
)

const cfg = {
  workspaceRoot: ws,
  assetsDir: '.assets',
  harnessUrl: '',
  defaultEncoding: 'utf8',
  theme: 'dark',
  aiWidth: 520,
  sideWidth: 200,
  llmBaseUrl: '',
  llmModel: '',
  llmApiKey: '',
}
writeFileSync(join(ud, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')

console.log('workspace:', ws)
console.log('userData :', ud)
console.log('config   :', JSON.stringify(cfg))
