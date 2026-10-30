import type { ThApi } from '@shared/api'

declare global {
  interface Window {
    th: ThApi
  }
}

export {}
