/**
 * 状态栏「更新芯片」的状态机。
 *
 * 之前的问题：芯片在「有新版本 / 正在下载」时点一下只弹一个 toast，
 * 用户体感就是「点了没反应」；下载卡住或安装失败时也没有任何出口。
 *
 * 现在把状态和点击行为集中在这里（纯函数，可单测）：
 *   - 任何状态下点击都有明确动作
 *   - 下载超过一段时间没进展 → stalled，提示手动下载
 *   - 更新失败 → failed，提示手动下载/重试
 */

import type { UpdateEvent } from '@shared/types'

export type ChipMode = 'none' | 'available' | 'downloading' | 'ready' | 'manual' | 'failed' | 'stalled'

export interface ChipState {
  mode: ChipMode
  visible: boolean
  label: string
  title: string
  version: string
  percent: number
  /** 手动下载地址（manual / failed / stalled 用） */
  url: string
  /** 最近一次收到进度的时间戳（ms），用于判断是否卡住 */
  lastProgressAt: number
}

export const DOWNLOAD_PAGE = 'http://47.109.100.9/#download'

/** 下载多久没有新进度就认为卡住了 */
export const STALL_MS = 30_000

export function initialChip(): ChipState {
  return {
    mode: 'none',
    visible: false,
    label: '有新版本',
    title: '有新版本',
    version: '',
    percent: 0,
    url: DOWNLOAD_PAGE,
    lastProgressAt: 0,
  }
}

export function applyUpdateEvent(state: ChipState, event: UpdateEvent, now = Date.now()): ChipState {
  switch (event.kind) {
    case 'checking':
      return state
    case 'available':
      return {
        ...state,
        mode: 'available',
        visible: true,
        version: event.version,
        percent: 0,
        label: `新版本 v${event.version}`,
        title: `发现 v${event.version}，正在后台下载；点一下可以手动下载`,
        lastProgressAt: now,
      }
    case 'progress':
      return {
        ...state,
        mode: 'downloading',
        visible: true,
        percent: event.percent,
        label: `下载中 ${event.percent}%`,
        title: `正在下载 v${state.version || ''}（${event.percent}%）；点一下可以手动下载`,
        lastProgressAt: now,
      }
    case 'downloaded':
      return {
        ...state,
        mode: 'ready',
        visible: true,
        version: event.version,
        percent: 100,
        label: `重启更新 v${event.version}`,
        title: '点一下重启并安装，用户数据不受影响',
      }
    case 'manual':
      return {
        ...state,
        mode: 'manual',
        visible: true,
        version: event.version,
        url: event.url || DOWNLOAD_PAGE,
        label: `新版本 v${event.version}`,
        title: '未签名的 macOS 版需要手动下载：点这里打开下载页',
      }
    case 'error':
      return {
        ...state,
        mode: 'failed',
        visible: true,
        label: '更新失败，点此手动下载',
        title: `自动更新失败：${event.message}；点一下打开下载页`,
        url: DOWNLOAD_PAGE,
      }
    case 'none':
      return { ...initialChip() }
    default:
      return state
  }
}

/** 定时器里调用：下载长时间没进展就转成 stalled，给用户一个手动出口 */
export function applyStall(state: ChipState, now = Date.now()): ChipState {
  if (state.mode !== 'downloading' && state.mode !== 'available') return state
  if (!state.lastProgressAt || now - state.lastProgressAt < STALL_MS) return state
  return {
    ...state,
    mode: 'stalled',
    label: '下载较慢，点此手动下载',
    title: `后台下载 v${state.version || ''} 似乎卡住了；点一下打开下载页手动安装`,
  }
}

/** 点击芯片时该做什么（由 main.ts 执行具体动作） */
export type ChipAction = 'install' | 'open-download' | 'recheck'

export function chipAction(state: ChipState): ChipAction {
  if (state.mode === 'ready') return 'install'
  if (state.mode === 'manual' || state.mode === 'failed' || state.mode === 'stalled') return 'open-download'
  if (state.mode === 'available' || state.mode === 'downloading') return 'open-download'
  return 'recheck'
}
