import { renderCardHtml } from './cardRender'

export interface CardDoc {
  title: string
  path: string | null
  text: string
}

export interface CardPanelDeps {
  getDoc: () => CardDoc | null
  resolveImage: (src: string, doc: CardDoc) => string | null
}

const THEMES = [
  { id: 'fresh', name: '清新自然' },
  { id: 'fairytale', name: '童话' },
  { id: 'notes', name: '备忘录' },
  { id: 'business', name: '商务' },
  { id: 'cyber', name: '暗夜' },
] as const

export interface CardPanel {
  toggle: () => void
  open: () => void
  close: () => void
  isOpen: () => boolean
  refresh: () => void
}

export function createCardPanel(deps: CardPanelDeps): CardPanel {
  let open = false
  let timer: number | undefined
  let theme: string = localStorage.getItem('th.cardTheme') ?? 'fresh'
  let scale = Number(localStorage.getItem('th.cardScale') ?? '0.72')
  let lastText = ''
  let lastPath: string | null = null
  let busy = false

  const panel = document.createElement('aside')
  panel.className = 'card-panel hidden'
  panel.innerHTML = `
    <div class="card-panel-head">
      <span class="card-panel-title">卡片预览</span>
      <span class="card-panel-sub">当前笔记 → 导出为图片</span>
      <button type="button" class="card-panel-close" title="关闭">×</button>
    </div>
    <div class="card-controls">
      <label>主题</label>
      <select class="card-theme"></select>
      <label>缩放</label>
      <input type="range" class="card-scale" min="40" max="100" step="5" value="72" />
      <span class="card-scale-val">72%</span>
    </div>
    <div class="card-stage">
      <article class="th-card" data-card-theme="fresh"></article>
    </div>
    <div class="card-foot">
      <button type="button" class="card-copy">复制图片</button>
      <button type="button" class="card-png">PNG</button>
      <button type="button" class="card-svg">SVG</button>
      <button type="button" class="card-pdf primary">PDF</button>
      <span class="card-status"></span>
    </div>
  `
  document.body.appendChild(panel)

  const themeSelect = panel.querySelector('.card-theme') as HTMLSelectElement
  const scaleRange = panel.querySelector('.card-scale') as HTMLInputElement
  const scaleLabel = panel.querySelector('.card-scale-val') as HTMLElement
  const card = panel.querySelector('.th-card') as HTMLElement
  const status = panel.querySelector('.card-status') as HTMLElement
  const emptyHint = document.createElement('div')
  emptyHint.className = 'card-panel-sub'
  emptyHint.textContent = '当前文档不是 Markdown，打开一篇 .md 再试。'
  emptyHint.style.padding = '24px'

  for (const item of THEMES) {
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = item.name
    themeSelect.appendChild(option)
  }

  const setStatus = (message: string): void => {
    status.textContent = message
    window.setTimeout(() => {
      if (status.textContent === message) status.textContent = ''
    }, 4000)
  }

  const applyScale = (): void => {
    card.style.zoom = String(scale)
    scaleLabel.textContent = `${Math.round(scale * 100)}%`
  }

  const render = (): void => {
    const doc = deps.getDoc()
    if (!doc) {
      card.innerHTML = ''
      card.appendChild(emptyHint)
      return
    }
    lastText = doc.text
    lastPath = doc.path
    card.dataset['cardTheme'] = theme
    card.innerHTML = renderCardHtml(doc.text, {
      resolveImage: (src) => deps.resolveImage(src, doc),
    })
    applyScale()
  }

  const refresh = (): void => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const doc = deps.getDoc()
      if (!doc) return
      if (doc.text === lastText && doc.path === lastPath) return
      render()
    }, 260)
  }

  const openPanel = (): void => {
    open = true
    panel.classList.remove('hidden')
    const doc = deps.getDoc()
    if (doc) {
      lastText = ''
      lastPath = null
      render()
    } else {
      card.innerHTML = ''
      card.appendChild(emptyHint)
    }
    panel.querySelector<HTMLButtonElement>('.card-copy')?.focus()
  }

  const closePanel = (): void => {
    open = false
    panel.classList.add('hidden')
  }

  panel.querySelector('.card-panel-close')?.addEventListener('click', closePanel)

  themeSelect.value = theme
  themeSelect.addEventListener('change', () => {
    theme = themeSelect.value
    localStorage.setItem('th.cardTheme', theme)
    render()
  })

  scaleRange.value = String(Math.round(scale * 100))
  scaleLabel.textContent = `${Math.round(scale * 100)}%`
  scaleRange.addEventListener('input', () => {
    scale = Number(scaleRange.value) / 100
    localStorage.setItem('th.cardScale', String(scale))
    applyScale()
  })

  const exportBlob = async (kind: 'png' | 'svg'): Promise<Blob | null> => {
    const doc = deps.getDoc()
    if (!doc) return null
    const { toBlob } = await import('html-to-image')
    const prevZoom = card.style.zoom
    card.style.zoom = '1'
    try {
      const blob = await toBlob(card, {
        pixelRatio: kind === 'png' ? 2 : 1,
        cacheBust: true,
        backgroundColor: kind === 'png' ? '#ffffff' : undefined,
      })
      return blob
    } finally {
      card.style.zoom = prevZoom
    }
  }

  const fileName = (suffix: string): string => {
    const doc = deps.getDoc()
    const base = (doc?.title ?? '笔记').replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '-')
    return `${base}-卡片.${suffix}`
  }

  panel.querySelector('.card-copy')?.addEventListener('click', () => {
    if (busy) return
    busy = true
    setStatus('正在生成图片…')
    void (async () => {
      try {
        const blob = await exportBlob('png')
        if (!blob) return
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setStatus('已复制到剪贴板')
      } catch (err) {
        setStatus(`复制失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        busy = false
      }
    })()
  })

  panel.querySelector('.card-png')?.addEventListener('click', () => {
    if (busy) return
    busy = true
    setStatus('正在导出 PNG…')
    void (async () => {
      try {
        const blob = await exportBlob('png')
        if (!blob) return
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        const result = await window.th.app.saveExport(dataUrl, fileName('png'), 'png')
        setStatus(result.ok ? `已保存：${result.path ?? ''}` : '已取消')
      } catch (err) {
        setStatus(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        busy = false
      }
    })()
  })

  panel.querySelector('.card-svg')?.addEventListener('click', () => {
    if (busy) return
    busy = true
    setStatus('正在导出 SVG…')
    void (async () => {
      try {
        const { toSvg } = await import('html-to-image')
        const prevZoom = card.style.zoom
        card.style.zoom = '1'
        let dataUrl = ''
        try {
          dataUrl = await toSvg(card, { cacheBust: true })
        } finally {
          card.style.zoom = prevZoom
        }
        // data:image/svg+xml;charset=utf-8,<encoded>
        const comma = dataUrl.indexOf(',')
        const svgText = comma >= 0 ? decodeURIComponent(dataUrl.slice(comma + 1)) : dataUrl
        const result = await window.th.app.saveExport(svgText, fileName('svg'), 'svg')
        setStatus(result.ok ? `已保存：${result.path ?? ''}` : '已取消')
      } catch (err) {
        setStatus(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        busy = false
      }
    })()
  })

  panel.querySelector('.card-pdf')?.addEventListener('click', () => {
    if (busy) return
    busy = true
    setStatus('正在生成 PDF…')
    void (async () => {
      try {
        const blob = await exportBlob('png')
        if (!blob) return
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        const result = await window.th.app.exportPdf(dataUrl, fileName('pdf'))
        setStatus(result.ok ? `已保存：${result.path ?? ''}` : '已取消')
      } catch (err) {
        setStatus(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        busy = false
      }
    })()
  })

  return {
    toggle: () => (open ? closePanel() : openPanel()),
    open: openPanel,
    close: closePanel,
    isOpen: () => open,
    refresh,
  }
}
