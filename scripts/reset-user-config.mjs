import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const ud = join(appData, 'textharness')
mkdirSync(ud, { recursive: true })

const workspace = process.env.TH_WORKSPACE || join(homedir(), 'Documents', 'agent-ws')

const cfg = {
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
  tasks: [
    {
      id: 'draft-kb',
      name: '草稿知识整理',
      enabled: true,
      trigger: { kind: 'idle', minutes: 60 },
      lastRunAt: null,
    },
  ],
}

writeFileSync(join(ud, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
console.log('written:', join(ud, 'config.json'))
console.log('workspace:', workspace)
