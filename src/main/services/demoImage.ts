import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { dayStamp } from './assets'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 生成一张 720x400 的渐变示例图（不依赖任何图像库） */
function makeDemoPng(): Buffer {
  const W = 720
  const H = 400
  const raw = Buffer.alloc((W * 4 + 1) * H)
  let offset = 0

  const barTop = 118
  const barBottom = 152
  const stemLeft = W / 2 - 24
  const stemRight = W / 2 + 24
  const stemBottom = 306

  for (let y = 0; y < H; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < W; x++) {
      const t = (x / W) * 0.55 + (y / H) * 0.45
      let r = Math.round(74 + (170 - 74) * t)
      let g = Math.round(120 + (110 - 120) * t)
      let b = Math.round(255 - (255 - 220) * t)

      const inBar = y >= barTop && y <= barBottom && x >= W / 2 - 96 && x <= W / 2 + 96
      const inStem = x >= stemLeft && x <= stemRight && y > barBottom && y <= stemBottom
      if (inBar || inStem) {
        r = 245
        g = 248
        b = 255
      }

      // 四周加一点暗角
      const dx = (x - W / 2) / (W / 2)
      const dy = (y - H / 2) / (H / 2)
      const vignette = Math.min(1, (dx * dx + dy * dy) * 0.28)
      r = Math.round(r * (1 - vignette))
      g = Math.round(g * (1 - vignette))
      b = Math.round(b * (1 - vignette))

      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 确保工作区里有一张可直接预览的示例图，
 * 让欢迎页的悬停预览有真实文件可指。
 */
export function ensureDemoImage(root: string): string {
  const dir = join(root, '.assets', 'img', dayStamp())
  const file = join(dir, 'demo.png')
  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, makeDemoPng())
    }
  } catch {
    /* 工作区不可写就算了，不影响启动 */
  }
  return file
}
