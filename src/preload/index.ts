import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface ToolReviewData {
  requestId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskDescription: string
  timeout: number
}

interface TaskQueryResult {
  success: boolean
  message: string
  tasks?: Task[]
  currentTask?: Task
}

/**
 * 任务数据结构（简化版）
 * - 状态简化为 pending/done
 * - 去掉 parentId、order（扁平结构）
 */
interface Task {
  id: string
  description: string
  status: 'pending' | 'done'
  deadline?: string
  createdAt: number
  updatedAt: number
  notes?: Array<{ type: string; content: string; timestamp: number }>
}

const api = {
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  getToolReviewData: (requestId: string): Promise<ToolReviewData | null> =>
    ipcRenderer.invoke('tool-review:getData', requestId),
  closeReview: (requestId: string) => ipcRenderer.send('tool-review:close', requestId),
  openTerminalManager: () => ipcRenderer.send('open-terminal-manager'),
  terminal: {
    list: (): Promise<any> => ipcRenderer.invoke('terminal:list'),
  },
  task: {
    list: (): Promise<TaskQueryResult> => ipcRenderer.invoke('task:list'),
    get: (taskId: string): Promise<any> => ipcRenderer.invoke('task:get', { taskId }),
    updateStatus: (taskId: string, status: string): Promise<any> =>
      ipcRenderer.invoke('task:updateStatus', { taskId, status }),
  },
  // 窗口管理 IPC 接口
  window: {
    setTop: (
      alwaysOnTop: boolean,
    ): Promise<{ success: boolean; alwaysOnTop?: boolean; error?: string }> =>
      ipcRenderer.invoke('window:setTop', { alwaysOnTop }),
    toggleTop: (): Promise<{ success: boolean; alwaysOnTop?: boolean; error?: string }> =>
      ipcRenderer.invoke('window:toggleTop'),
    getState: (): Promise<{ success: boolean; alwaysOnTop?: boolean; error?: string }> =>
      ipcRenderer.invoke('window:getState'),
    setIgnoreMouse: (
      state: boolean,
      option?: any,
    ): Promise<{ success: boolean; state?: boolean; error?: string }> =>
      ipcRenderer.invoke('window:setIgnoreMouse', { state, option }),
    resetPosition: (): Promise<{ success: boolean; reset?: boolean; error?: string }> =>
      ipcRenderer.invoke('window:resetPosition'),
  },
  // 弹窗管理 IPC 接口
  popup: {
    reopen: (data: {
      id: string
      title?: string
      content?: string
      width?: number
      height?: number
      x?: number
      y?: number
      popupType?: string
    }): Promise<{ success: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke('popup:reopen', data),
    create: (data: {
      id: string
      content: string
      title: string
      width: number
      height: number
      x: number
      y: number
      duration: number
      popupType: string
    }): Promise<{ success: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke('popup:create', data),
  },
  // 审查窗口管理 IPC 接口
  review: {
    create: (data: {
      requestId: string
      toolName: string
      toolArgs: Record<string, unknown>
      riskDescription: string
      timeout: number
    }): Promise<{ success: boolean; requestId?: string; error?: string }> =>
      ipcRenderer.invoke('review:create', data),
  },
  // 模型配置 IPC 接口
  model: {
    getConfig: (): Promise<{
      modelUrl: string
      idleBehaviorsPath: string | null
      defaultParamsPath: string | null
      defaultParams: Array<{ id: string; value: number }>
    }> => ipcRenderer.invoke('model:getConfig'),
  },
  // 配置中心 IPC 接口
  settings: {
    getConfig: (): Promise<{ success: boolean; config?: any; error?: string }> =>
      ipcRenderer.invoke('settings:getConfig'),
    saveWhitelist: (whitelist: string[]): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:saveWhitelist', whitelist),
    saveTruncation: (config: {
      defaultMaxChars: number
      defaultMaxLines: number
      defaultMode: string
      strategies: Record<string, { maxChars?: number; maxLines?: number; mode?: string }>
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:saveTruncation', config),
    getMCPServers: (): Promise<{ success: boolean; servers?: any[]; error?: string }> =>
      ipcRenderer.invoke('settings:getMCPServers'),
    refreshMCP: (
      serverName: string,
    ): Promise<{ success: boolean; message?: string; error?: string }> =>
      ipcRenderer.invoke('settings:refreshMCP', serverName),
    refreshAllMCP: (): Promise<{ success: boolean; results?: any[]; error?: string }> =>
      ipcRenderer.invoke('settings:refreshAllMCP'),
    getMCPTools: (): Promise<{ success: boolean; tools?: string[]; error?: string }> =>
      ipcRenderer.invoke('settings:getMCPTools'),
  },
  // 主进程事件监听接口
  on: (channel: string, callback: (...args: any[]) => void) => {
    // 只允许监听白名单中的事件
    const validChannels = [
      'window-state-changed',
      'toggle-character-visibility',
      'focus-input',
      'position-reset',
      'position_reset',
      'splash:progress',
      'splash:fade-out',
    ]
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => callback(...args))
    } else {
      console.warn(`[preload] 不允许监听频道: ${channel}`)
    }
  },
  off: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback)
  },
  // IPC 发送接口（用于渲染进程向主进程发送消息）
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      const validChannels = ['model:loaded', 'window-minimize', 'window-close', 'window-start-drag']
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, ...args)
      } else {
        console.warn(`[preload] 不允许发送频道: ${channel}`)
      }
    },
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
