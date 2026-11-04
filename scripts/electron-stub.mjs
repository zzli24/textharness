/**
 * electron 的最小桩：给 node 里跑的单元测试用（agent 会间接 import 到 electron）。
 * 只实现被引用到的几个 API，别在这里加业务逻辑。
 */
export const app = {
  getPath: () => `${process.cwd()}/.tmp/agent-test-userdata`,
  isPackaged: false,
  getVersion: () => '0.0.0-test',
}

export const BrowserWindow = {
  getAllWindows: () => [],
  fromWebContents: () => null,
}

export const dialog = {
  showMessageBox: async () => ({ response: 0 }),
}

export const shell = {
  openPath: async () => '',
  openExternal: async () => {},
  showItemInFolder: () => {},
}

export const clipboard = {
  readText: () => '',
  writeText: () => {},
}

export const ipcMain = {
  handle: () => {},
  on: () => {},
}

export const net = {
  fetch: (...args) => fetch(...args),
}

export default { app, BrowserWindow, dialog, shell, clipboard, ipcMain, net }
