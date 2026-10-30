// 为演示准备默认 userData 配置：工作区指向带内容的 agent-ws
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ud = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'TextHarness')
mkdirSync(ud, { recursive: true })

const cfgPath = join(ud, 'config.json')
const workspace = join(homedir(), 'Documents', '随写', 'agent-ws')

let current = {}
if (existsSync(cfgPath)) {
  try {
    current = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    current = {}
  }
}

const next = {
  workspaceRoot: workspace,
  assetsDir: '.assets',
  defaultEncoding: 'utf8',
  theme: 'dark',
  aiWidth: 470,
  sideWidth: 190,
  llmBaseUrl: '',
  llmModel: '',
  llmApiKey: '',
  catchUpOnLaunch: false,
  ...current,
}
// 演示时不要自动跑任务
next.catchUpOnLaunch = false
next.workspaceRoot = workspace

writeFileSync(cfgPath, JSON.stringify(next, null, 2), 'utf8')
console.log('config:', cfgPath)
console.log('workspace:', workspace)
console.log('exists:', existsSync(workspace))
