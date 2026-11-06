import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import mammoth from 'mammoth'
import TurndownService from 'turndown'

export type ImportSource = 'markdown' | 'enex' | 'docx' | 'html' | 'zip'
export type ConflictMode = 'rename' | 'skip' | 'overwrite'

export interface ImportOptions {
  source: ImportSource
  inputPath: string
  workspaceRoot: string
  /** 默认放到 工作区/导入/ */
  conflict?: ConflictMode
}

export interface ImportResult {
  ok: boolean
  source: ImportSource
  targetDir: string
  imported: number
  skipped: number
  failed: number
  errors: string[]
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const MARKDOWN_EXT = new Set(['.md', '.markdown'])
const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.history'])

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

function stamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || '未命名'
}

function uniqueName(dir: string, name: string, used: Set<string>): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  let index = 1
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${index}${ext}`
    index += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

async function walk(root: string, current = root, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(root, join(current, entry.name), out)
    } else {
      out.push(join(current, entry.name))
    }
  }
  return out
}

/** 把 HTML 转成 Markdown（Evernote / Word / 网页共用） */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim()
}

/** 从 ENML 里去掉 OneNote/Evernote 专用标签，保留正文 */
function cleanEnml(content: string): string {
  return content
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<en-media[^>]*>/gi, '')
    .replace(/<en-todo[^>]*\/?>/gi, '- [ ] ')
    .replace(/<en-crypt[^>]*>[\s\S]*?<\/en-crypt>/gi, '[加密内容]')
}

interface EnNote {
  title: string
  content: string
  created?: string
  updated?: string
  attachments: Array<{ name: string; data: Buffer; mime: string }>
}

function parseEnex(xml: string): EnNote[] {
  const notes: EnNote[] = []
  const noteBlocks = xml.match(/<note>[\s\S]*?<\/note>/gi) ?? []
  for (const block of noteBlocks) {
    const pick = (tag: string): string => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
      return m ? m[1].trim() : ''
    }
    const title = pick('title') || '未命名笔记'
    const content = pick('content').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    const attachments: EnNote['attachments'] = []
    const resources = block.match(/<resource>[\s\S]*?<\/resource>/gi) ?? []
    let index = 0
    for (const resource of resources) {
      index += 1
      const dataMatch = /<data[^>]*encoding="base64"[^>]*>([\s\S]*?)<\/data>/i.exec(resource)
      if (!dataMatch) continue
      const mimeMatch = /<mime>([\s\S]*?)<\/mime>/i.exec(resource)
      const nameMatch = /<file-name>([\s\S]*?)<\/file-name>/i.exec(resource)
      const mime = mimeMatch?.[1].trim() || 'application/octet-stream'
      const extension = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : mime.includes('gif') ? 'gif' : mime.includes('pdf') ? 'pdf' : 'bin'
      attachments.push({
        name: safeName((nameMatch?.[1] ?? `附件-${index}`).trim()) || `附件-${index}.${extension}`,
        data: Buffer.from(dataMatch[1].replace(/\s+/g, ''), 'base64'),
        mime,
      })
    }
    notes.push({
      title: safeName(title),
      content: cleanEnml(content),
      created: pick('created') || undefined,
      updated: pick('updated') || undefined,
      attachments,
    })
  }
  return notes
}

async function copyMarkdownTree(sourceRoot: string, targetDir: string, result: ImportResult, used: Set<string>): Promise<void> {
  const files = await walk(sourceRoot)
  for (const file of files) {
    const rel = relative(sourceRoot, file)
    const ext = extname(file).toLowerCase()
    const isMarkdown = MARKDOWN_EXT.has(ext)
    const isAsset = IMAGE_EXT.has(ext)
    if (!isMarkdown && !isAsset) continue
    try {
      const relParts = rel.split(sep).map(safeName)
      const target = join(targetDir, ...relParts)
      await fs.mkdir(dirname(target), { recursive: true })
      if (result) {
        // 只在 markdown 文件上计数
      }
      const exists = await fs.stat(target).then(() => true).catch(() => false)
      if (exists) {
        result.skipped += 1
        continue
      }
      await fs.copyFile(file, target)
      if (isMarkdown) result.imported += 1
    } catch (err) {
      result.failed += 1
      result.errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  void used
}

/** 主入口：把外部笔记导入到 工作区/导入/<来源>-<时间> */
export async function importNotes(options: ImportOptions): Promise<ImportResult> {
  const conflict: ConflictMode = options.conflict ?? 'rename'
  const sourceName =
    options.source === 'markdown'
      ? 'markdown'
      : options.source === 'enex'
        ? 'evernote'
        : options.source === 'docx'
          ? 'word'
          : options.source === 'zip'
            ? 'zip'
            : 'html'
  const targetDir = join(options.workspaceRoot, '导入', `${stamp()}-${sourceName}`)
  const result: ImportResult = {
    ok: true,
    source: options.source,
    targetDir,
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }
  const used = new Set<string>()

  try {
    await fs.mkdir(targetDir, { recursive: true })
    const stat = await fs.stat(options.inputPath)

    if (options.source === 'markdown') {
      if (stat.isDirectory()) {
        await copyMarkdownTree(options.inputPath, targetDir, result, used)
      } else {
        const name = uniqueName(targetDir, safeName(basename(options.inputPath)), used)
        await fs.copyFile(options.inputPath, join(targetDir, name))
        result.imported = 1
      }
    } else if (options.source === 'zip') {
      const zip = new AdmZip(options.inputPath)
      const temp = join(targetDir, '.extract')
      await fs.mkdir(temp, { recursive: true })
      zip.extractAllTo(temp, true)
      await copyMarkdownTree(temp, targetDir, result, used)
      await fs.rm(temp, { recursive: true, force: true })
    } else if (options.source === 'enex') {
      const xml = await fs.readFile(options.inputPath, 'utf8')
      const notes = parseEnex(xml)
      const attachDir = join(targetDir, '_attachments')
      await fs.mkdir(attachDir, { recursive: true })
      for (const note of notes) {
        try {
          const body = htmlToMarkdown(note.content)
          const attachmentLines: string[] = []
          for (const asset of note.attachments) {
            const name = uniqueName(attachDir, safeName(asset.name), used)
            await fs.writeFile(join(attachDir, name), asset.data)
            if (asset.mime.startsWith('image/')) attachmentLines.push(`![${name}](_attachments/${name})`)
            else attachmentLines.push(`- [${name}](_attachments/${name})`)
          }
          const header = note.created ? `---\ncreated: ${note.created}\n---\n\n` : ''
          const content = `${header}${body}${attachmentLines.length ? `\n\n## 附件\n\n${attachmentLines.join('\n')}\n` : ''}\n`
          const file = uniqueName(targetDir, `${note.title}.md`, used)
          const target = join(targetDir, file)
          if (conflict === 'skip' && (await fs.stat(target).then(() => true).catch(() => false))) {
            result.skipped += 1
            continue
          }
          await fs.writeFile(target, content, 'utf8')
          result.imported += 1
        } catch (err) {
          result.failed += 1
          result.errors.push(`${note.title}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } else if (options.source === 'docx') {
      const converted = await mammoth.convertToHtml({ path: options.inputPath })
      const markdown = htmlToMarkdown(converted.value)
      const file = uniqueName(targetDir, `${safeName(basename(options.inputPath, extname(options.inputPath)))}.md`, used)
      await fs.writeFile(join(targetDir, file), markdown + '\n', 'utf8')
      result.imported = 1
    } else {
      const html = await fs.readFile(options.inputPath, 'utf8')
      const markdown = htmlToMarkdown(html)
      const file = uniqueName(targetDir, `${safeName(basename(options.inputPath, extname(options.inputPath)))}.md`, used)
      await fs.writeFile(join(targetDir, file), markdown + '\n', 'utf8')
      result.imported = 1
    }
  } catch (err) {
    result.ok = false
    result.failed += 1
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  return result
}

/** 给备份用：列出要打包的文件（排除 .history 等） */
export async function listBackupFiles(root: string): Promise<string[]> {
  const files = await walk(root)
  return files.filter((file) => {
    const rel = relative(root, file)
    return !rel.startsWith('.history') && !rel.startsWith('.backups') && !rel.includes(`${sep}.git${sep}`)
  })
}

export { createHash }
