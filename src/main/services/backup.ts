import { promises as fs } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import AdmZip from 'adm-zip'
import { listBackupFiles } from './importer'

export interface BackupResult {
  ok: boolean
  path?: string
  files: number
  bytes: number
  error?: string
}

/** 把整个工作区打成 zip（排除 .history / .backups / .git） */
export async function createBackup(workspaceRoot: string, outPath: string): Promise<BackupResult> {
  try {
    const files = await listBackupFiles(workspaceRoot)
    await fs.mkdir(dirname(outPath), { recursive: true })
    const zip = new AdmZip()
    for (const file of files) {
      const rel = relative(workspaceRoot, file)
      if (!rel || rel.startsWith('..')) continue
      const parts = rel.split(sep)
      const zipDir = parts.slice(0, -1).join('/')
      zip.addLocalFile(file, zipDir, parts[parts.length - 1])
    }
    const manifest = {
      app: 'TextHarness',
      createdAt: new Date().toISOString(),
      workspace: workspaceRoot,
      files: files.length,
    }
    zip.addFile('_backup.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
    zip.writeZip(outPath)
    const stat = await fs.stat(outPath)
    return { ok: true, path: outPath, files: files.length, bytes: stat.size }
  } catch (err) {
    return {
      ok: false,
      files: 0,
      bytes: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface RestoreResult {
  ok: boolean
  restored: number
  skipped: number
  error?: string
}

/** 从 zip 恢复到工作区；同名文件自动加 -1 后缀，不覆盖 */
export async function restoreBackup(zipPath: string, workspaceRoot: string): Promise<RestoreResult> {
  try {
    const zip = new AdmZip(zipPath)
    const used = new Set<string>()
    let restored = 0
    let skipped = 0
    const rootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep

    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const name = entry.entryName.replace(/\\/g, '/')
      if (!name || name === '_backup.json' || name.startsWith('..') || name.includes('/../')) {
        skipped += 1
        continue
      }
      const target = join(workspaceRoot, ...name.split('/'))
      if (!target.startsWith(rootPrefix)) {
        skipped += 1
        continue
      }
      await fs.mkdir(dirname(target), { recursive: true })
      let finalPath = target
      if (used.has(finalPath.toLowerCase()) || (await fs.stat(finalPath).then(() => true).catch(() => false))) {
        const base = name.split('/').pop() ?? name
        const dir = name.slice(0, name.length - base.length)
        const dot = base.lastIndexOf('.')
        const stem = dot > 0 ? base.slice(0, dot) : base
        const ext = dot > 0 ? base.slice(dot) : ''
        let index = 1
        while (await fs.stat(finalPath).then(() => true).catch(() => false)) {
          finalPath = join(workspaceRoot, ...(dir + `${stem}-${index}${ext}`).split('/'))
          index += 1
          if (index > 999) break
        }
      }
      used.add(finalPath.toLowerCase())
      await fs.writeFile(finalPath, entry.getData())
      restored += 1
    }

    return { ok: true, restored, skipped }
  } catch (err) {
    return {
      ok: false,
      restored: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
