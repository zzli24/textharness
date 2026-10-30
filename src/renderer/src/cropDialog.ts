import { createModal } from './dialogs'

export interface CropSpec {
  dataUrl: string
  name: string
}

/**
 * 自定义背景图裁剪：把整张图拖到想要的区域、滚轮缩放，
 * 画布看到的就是最终铺满窗口的样子。
 */
export function openCropDialog(spec: CropSpec): Promise<string | null> {
  return new Promise((resolve) => {
    const parts = createModal('选取背景范围')
    parts.root.querySelector<HTMLElement>('.modal')?.classList.add('crop-modal')

    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = '拖动图片调整位置，滚轮或滑杆缩放。框里看到的，就是设置成背景后的效果。'
    parts.body.appendChild(hint)

    const frame = document.createElement('div')
    frame.className = 'crop-frame'
    const canvas = document.createElement('canvas')
    canvas.className = 'crop-canvas'
    canvas.width = 1280
    canvas.height = 720
    frame.appendChild(canvas)
    parts.body.appendChild(frame)

    const zoomRow = document.createElement('div')
    zoomRow.className = 'crop-zoom'
    const zoomLabel = document.createElement('span')
    zoomLabel.textContent = '缩放'
    const zoomRange = document.createElement('input')
    zoomRange.type = 'range'
    zoomRange.min = '100'
    zoomRange.max = '400'
    zoomRange.value = '100'
    const zoomValue = document.createElement('span')
    zoomValue.className = 'val'
    zoomValue.textContent = '100%'
    zoomRow.append(zoomLabel, zoomRange, zoomValue)
    parts.body.appendChild(zoomRow)

    const footerNote = document.createElement('div')
    footerNote.className = 'agents-status'
    footerNote.textContent = '输出 1600×900，保存到工作区 .assets/bg/'
    parts.body.appendChild(footerNote)

    const cancel = document.createElement('button')
    cancel.className = 'btn'
    cancel.textContent = '取消'
    const reset = document.createElement('button')
    reset.className = 'btn'
    reset.textContent = '重置'
    const confirm = document.createElement('button')
    confirm.className = 'btn primary'
    confirm.textContent = '使用这个范围'
    parts.foot.append(cancel, reset, confirm)

    const ctx = canvas.getContext('2d')
    const image = new Image()
    let ready = false
    // 图片原始尺寸
    let iw = 0
    let ih = 0
    // 视图变换：scale 为「显示像素 / 图像像素」，offset 为图像左上角在画布中的位置
    let scale = 1
    let offsetX = 0
    let offsetY = 0
    let minScale = 1
    let zoom = 1

    const clamp = (): void => {
      // 不让画布出现空白边
      const drawW = iw * scale
      const drawH = ih * scale
      const minX = canvas.width - drawW
      const minY = canvas.height - drawH
      offsetX = drawW <= canvas.width ? (canvas.width - drawW) / 2 : Math.min(0, Math.max(minX, offsetX))
      offsetY = drawH <= canvas.height ? (canvas.height - drawH) / 2 : Math.min(0, Math.max(minY, offsetY))
    }

    const draw = (): void => {
      if (!ctx || !ready) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, offsetX, offsetY, iw * scale, ih * scale)
    }

    const applyZoom = (nextZoom: number, anchorX?: number, anchorY?: number): void => {
      const clampedZoom = Math.min(4, Math.max(1, nextZoom))
      const nextScale = minScale * clampedZoom
      // 以鼠标位置为锚点缩放，手感更自然
      const ax = anchorX ?? canvas.width / 2
      const ay = anchorY ?? canvas.height / 2
      const imageX = (ax - offsetX) / scale
      const imageY = (ay - offsetY) / scale
      scale = nextScale
      zoom = clampedZoom
      offsetX = ax - imageX * scale
      offsetY = ay - imageY * scale
      zoomRange.value = String(Math.round(zoom * 100))
      zoomValue.textContent = `${Math.round(zoom * 100)}%`
      clamp()
      draw()
    }

    image.addEventListener('load', () => {
      iw = image.naturalWidth
      ih = image.naturalHeight
      ready = true
      // 初始：铺满（cover）
      minScale = Math.max(canvas.width / iw, canvas.height / ih)
      scale = minScale
      offsetX = (canvas.width - iw * scale) / 2
      offsetY = (canvas.height - ih * scale) / 2
      draw()
    })
    image.addEventListener('error', () => {
      footerNote.textContent = '图片读取失败，换一张试试'
    })
    image.src = spec.dataUrl

    /* 拖动 */
    let dragging = false
    let lastX = 0
    let lastY = 0
    canvas.addEventListener('pointerdown', (event) => {
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const ratio = canvas.width / canvas.getBoundingClientRect().width
      offsetX += (event.clientX - lastX) * ratio
      offsetY += (event.clientY - lastY) * ratio
      lastX = event.clientX
      lastY = event.clientY
      clamp()
      draw()
    })
    const stopDrag = (): void => {
      dragging = false
    }
    canvas.addEventListener('pointerup', stopDrag)
    canvas.addEventListener('pointercancel', stopDrag)

    /* 滚轮缩放 */
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const ratio = canvas.width / rect.width
        applyZoom(zoom * (event.deltaY > 0 ? 0.92 : 1.08), (event.clientX - rect.left) * ratio, (event.clientY - rect.top) * ratio)
      },
      { passive: false }
    )

    zoomRange.addEventListener('input', () => {
      applyZoom(Number(zoomRange.value) / 100)
    })

    reset.addEventListener('click', () => {
      if (!ready) return
      scale = minScale
      zoom = 1
      zoomRange.value = '100'
      zoomValue.textContent = '100%'
      offsetX = (canvas.width - iw * scale) / 2
      offsetY = (canvas.height - ih * scale) / 2
      draw()
    })

    const finish = (value: string | null): void => {
      parts.close()
      resolve(value)
    }

    cancel.addEventListener('click', () => finish(null))
    parts.root.addEventListener('mousedown', (event) => {
      if (event.target === parts.root) finish(null)
    })
    document.addEventListener('keydown', function onEsc(event) {
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onEsc, true)
        finish(null)
      }
    }, true)

    confirm.addEventListener('click', () => {
      if (!ready) return
      // 按画布同样的取景，输出 1600×900
      const outW = 1600
      const outH = 900
      const out = document.createElement('canvas')
      out.width = outW
      out.height = outH
      const outCtx = out.getContext('2d')
      if (!outCtx) return
      const k = outW / canvas.width
      outCtx.drawImage(image, offsetX * k, offsetY * k, iw * scale * k, ih * scale * k)
      finish(out.toDataURL('image/jpeg', 0.9))
    })
  })
}
