import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SessionSummary, StoredSession } from '@shared/types'

export type { SessionSummary, StoredMessage, StoredSession, StoredTool } from '@shared/types'

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/

function sessionsDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

/** 会话图片目录：data URL 太大，落成文件，消息里只留引用 */
function imagesDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error('非法的会话 id')
  return join(app.getPath('userData'), 'session-images', id)
}

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/

/** 保存前：把 data URL 写成文件，返回 th-img: 引用 */
async function offloadImages(sessionId: string, messages: StoredSession['messages']): Promise<StoredSession['messages']> {
  const out: StoredSession['messages'] = []
  let counter = 0
  for (const message of messages) {
    if (!message.images || message.images.length === 0) {
      out.push(message)
      continue
    }
    const refs: string[] = []
    for (const src of message.images.slice(0, 4)) {
      const match = DATA_URL_RE.exec(src)
      if (!match) continue
      // 单张超过 3MB 就不存了，避免会话文件膨胀
      if (src.length > 4_000_000) continue
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
      const name = `${Date.now()}-${counter++}.${ext}`
      const dir = imagesDir(sessionId)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, name), Buffer.from(match[2], 'base64'))
      refs.push(`th-img:${sessionId}/${name}`)
    }
    out.push({ ...message, images: refs.length > 0 ? refs : undefined })
  }
  return out
}

/** 读取时：把 th-img: 引用还原成 data URL */
async function hydrateImages(messages: StoredSession['messages']): Promise<StoredSession['messages']> {
  const out: StoredSession['messages'] = []
  for (const message of messages) {
    if (!message.images || message.images.length === 0) {
      out.push(message)
      continue
    }
    const urls: string[] = []
    for (const ref of message.images) {
      if (!ref.startsWith('th-img:')) {
        urls.push(ref)
        continue
      }
      const [id, name] = ref.slice('th-img:'.length).split('/')
      if (!id || !name || !ID_RE.test(id)) continue
      try {
        const buffer = await fs.readFile(join(imagesDir(id), name))
        const ext = name.split('.').pop() ?? 'png'
        const mime = ext === 'jpg' ? 'jpeg' : ext
        urls.push(`data:image/${mime};base64,${buffer.toString('base64')}`)
      } catch {
        /* 图没了就跳过 */
      }
    }
    out.push({ ...message, images: urls.length > 0 ? urls : undefined })
  }
  return out
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
  data.messages = await offloadImages(session.id, data.messages)
  await fs.writeFile(fileOf(session.id), JSON.stringify(data), 'utf8')
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileOf(id), 'utf8')) as StoredSession
    parsed.messages = await hydrateImages(parsed.messages ?? [])
    return parsed
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
  try {
    await fs.rm(imagesDir(id), { recursive: true, force: true })
  } catch {
    /* 没图就算了 */
  }
}
