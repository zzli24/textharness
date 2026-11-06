import { marked } from 'marked'

export interface CardRenderOptions {
  /** 把 Markdown 里的图片地址转成能加载的 URL（相对路径 → th-asset） */
  resolveImage?: (src: string) => string | null
}

marked.setOptions({ gfm: true, breaks: false })

/** Markdown → 卡片 HTML（只负责正文，外层卡片容器由 cardPanel 提供） */
export function renderCardHtml(markdown: string, options: CardRenderOptions = {}): string {
  const raw = marked.parse(markdown, { async: false }) as string
  const box = document.createElement('div')
  box.innerHTML = raw

  for (const img of Array.from(box.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    const fixed = options.resolveImage?.(src)
    if (fixed) img.setAttribute('src', fixed)
    img.setAttribute('loading', 'lazy')
  }

  // 表格包一层，窄屏可横向滚动
  for (const table of Array.from(box.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('card-table-wrap')) continue
    const wrap = document.createElement('div')
    wrap.className = 'card-table-wrap'
    table.replaceWith(wrap)
    wrap.appendChild(table)
  }

  // 代码块：语言类名 + 自动换行交给 CSS
  for (const code of Array.from(box.querySelectorAll('pre > code'))) {
    const cls = code.className
    if (cls) code.parentElement?.setAttribute('data-lang', cls.replace('language-', ''))
  }

  // 外链在新窗口/浏览器打开（导出图片时无影响）
  for (const link of Array.from(box.querySelectorAll('a'))) {
    link.setAttribute('rel', 'noreferrer')
    link.setAttribute('target', '_blank')
  }

  return box.innerHTML
}
