import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const ud = join(root, '.tmp', 'ud14')
mkdirSync(ud, { recursive: true })
writeFileSync(
  join(ud, 'config.json'),
  JSON.stringify(
    {
      workspaceRoot: join(root, '..', 'agent-ws'),
      assetsDir: '.assets',
      defaultEncoding: 'utf8',
      theme: 'dark',
      aiWidth: 480,
      sideWidth: 180,
      llmBaseUrl: 'https://api.deepseek.com/v1',
      llmModel: 'deepseek-chat',
      llmApiKey: 'sk-invalid',
      catchUpOnLaunch: false,
      tasks: [],
    },
    null,
    2
  ),
  'utf8'
)
console.log('ud14 ready')
