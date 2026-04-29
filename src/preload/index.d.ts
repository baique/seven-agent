import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface ContinuousAction {
    id: string
    intensity?: number
  }

  interface EmotionItem {
    name: string
    intensity: number
    reason: string
    timestamp: number
  }

  interface CurrentExpression {
    id: string
    params: { name: string; value: number; defValue: number }[]
    startTime: number
    intensity?: number
  }

  interface CurrentAction {
    id: string
    params: { name: string; value: number; defValue: number }[]
    startTime: number
    intensity?: number
  }

  interface CharacterStateData {
    emotions: EmotionItem[]
    currentExpressions: CurrentExpression[]
    currentAction: CurrentAction | null
    activity: string
    lastUpdateTime: number
  }

  interface InstantState {
    emotions: EmotionItem[]
    currentExpressions: CurrentExpression[]
    currentAction: CurrentAction | null
    activity: string
    lastUpdateTime: number
  }

  /**
   * 状态指令 (与主进程 socket/parser/index.ts 保持同步)
   * type: 1=表情, 2=动作, 3=情绪
   */
  interface StateCommandLite {
    type: 1 | 2 | 3
    id: string
    duration?: 'persistent' | 'instant'
    intensity?: number
  }

  interface Window {
    electron: ElectronAPI
    /**
     * 仅保留无法通过 socket 实现的窗口操作 API
     */
    api: {
      minimize: () => void
      close: () => void
      onLive2DMouseEvent: (callback: (data: any) => void) => void
      getToolReviewData: (requestId: string) => Promise<ToolReviewData | null>
      closeReview: (requestId: string) => void
      openTerminalManager: () => void
      terminal: {
        list: () => Promise<any>
      }
      task: {
        list: () => Promise<any>
        get: (taskId: string) => Promise<any>
        updateStatus: (taskId: string, status: string) => Promise<any>
      }
      // 窗口管理 IPC 接口
      window: {
        setTop: (
          alwaysOnTop: boolean,
        ) => Promise<{ success: boolean; alwaysOnTop?: boolean; error?: string }>
        toggleTop: () => Promise<{ success: boolean; alwaysOnTop?: boolean; error?: string }>
        getState: () => Promise<{ success: boolean; alwaysOnTop?: boolean; error?: string }>
        setIgnoreMouse: (
          state: boolean,
          option?: any,
        ) => Promise<{ success: boolean; state?: boolean; error?: string }>
        resetPosition: () => Promise<{ success: boolean; reset?: boolean; error?: string }>
      }
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
        }) => Promise<{ success: boolean; id?: string; error?: string }>
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
        }) => Promise<{ success: boolean; id?: string; error?: string }>
      }
      // 模型配置 IPC 接口
      model: {
        getConfig: () => Promise<{
          modelUrl: string
          idleBehaviorsPath: string | null
          defaultParamsPath: string | null
          defaultParams: Array<{ id: string; value: number }>
        }>
      }
      // 配置中心 IPC 接口
      settings: {
        getConfig: () => Promise<{ success: boolean; config?: any; error?: string }>
        saveWhitelist: (whitelist: string[]) => Promise<{ success: boolean; error?: string }>
        saveTruncation: (config: {
          defaultMaxChars: number
          defaultMaxLines: number
          defaultMode: string
          strategies: Record<string, { maxChars?: number; maxLines?: number; mode?: string }>
        }) => Promise<{ success: boolean; error?: string }>
        getMCPServers: () => Promise<{ success: boolean; servers?: any[]; error?: string }>
        refreshMCP: (
          serverName: string,
        ) => Promise<{ success: boolean; message?: string; error?: string }>
        refreshAllMCP: () => Promise<{ success: boolean; results?: any[]; error?: string }>
        getMCPTools: () => Promise<{ success: boolean; tools?: string[]; error?: string }>
      }
      // 主进程事件监听接口
      on: (channel: string, callback: (...args: any[]) => void) => void
      off: (channel: string, callback: (...args: any[]) => void) => void
      // IPC 发送接口
      ipcRenderer: {
        send: (channel: string, ...args: any[]) => void
        invoke: (channel: string, ...args: any[]) => Promise<any>
      }
    }
  }

  interface ToolReviewData {
    requestId: string
    toolName: string
    toolArgs: Record<string, unknown>
    riskDescription: string
    timeout: number
  }
}
