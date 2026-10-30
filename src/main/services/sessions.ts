import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SessionSummary, StoredSession } from '@shared/types'

export type { SessionSummary, StoredMessage, StoredSession, StoredTool } from '@shared/types'

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/

function sessionsDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

function fileOf(id: string): string {
  if (!ID_RE.test(id)) throw new Error('非法的会话 id')
  return join(sessionsDir(), `${id}.json`)
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true })
}

export async function saveSession(session: StoredSession): Promise<void> {
  await ensureDir()
  const data: StoredSession = {
    id: session.id,
    title: session.title.slice(0, 60) || '未命名会话',
    updatedAt: session.updatedAt || Date.now(),
    messages: session.messages.slice(-400),
  }
  await fs.writeFile(fileOf(session.id), JSON.stringify(data), 'utf8')
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  try {
    return JSON.parse(await fs.readFile(fileOf(id), 'utf8')) as StoredSession
  } catch {
    return null
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureDir()
  let names: string[] = []
  try {
    names = await fs.readdir(sessionsDir())
  } catch {
    return []
  }

  const out: SessionSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!ID_RE.test(id)) continue
    try {
      const data = JSON.parse(await fs.readFile(join(sessionsDir(), name), 'utf8')) as StoredSession
      out.push({
        id,
        title: data.title || '未命名会话',
        updatedAt: data.updatedAt || 0,
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
      })
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50)
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await fs.rm(fileOf(id))
  } catch {
    /* 不存在就算了 */
  }
}
