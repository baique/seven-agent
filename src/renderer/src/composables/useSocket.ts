import { ref, onUnmounted } from 'vue'
import { createSocketClient, SocketClient } from '../socket'
import type { SocketResponse } from '../socket/types'
import { eventBus, Events } from '../eventBus'
import type { AudioCommand, StateCommand, PauseCommand } from './useCharacterAction'
import type { RawMessage, HistoryLoadParams, Message } from '../types/message'
import {
  setWindowTop as ipcSetWindowTop,
  toggleWindowTop as ipcToggleWindowTop,
  getWindowState as ipcGetWindowState,
  setIgnoreMouse as ipcSetIgnoreMouse,
  resetWindowPosition as ipcResetWindowPosition,
  reopenPopup as ipcReopenPopup,
  ipcCreatePopup,
  ipcCreateReview,
  getModelConfig as ipcGetModelConfig,
} from './useIpc'

export interface TTSResult {
  audioBase64: string
  duration: number
}

/** 模型参数配置 */
export interface ModelParam {
  id: string
  value: number
}

/** 模型完整配置 */
export interface Live2DModelConfig {
  modelUrl: string
  idleBehaviorsPath: string | null
  defaultParamsPath: string | null
  defaultParams: ModelParam[]
}

const client = ref<SocketClient | null>(null)
const connected = ref(false)
let httpPort = 9172

const connect = async (port: number) => {
  onUnmounted(() => {
    disconnect()
  })
  httpPort = port
  const socket = createSocketClient({ host: 'localhost', port })
  await socket.connect()
  client.value = socket
  connected.value = true
  // 注意：SOCKET_READY 事件由服务器发送的 socket:ready 消息触发
  // 不在此处主动触发，避免重复执行初始化逻辑

  const socketHandler = socket.getHandler()

  socketHandler.register(
    Events.MESSAGE_COMMAND,
    (res: SocketResponse<AudioCommand | StateCommand | PauseCommand>) => {
      if (res.data) {
        eventBus.emit(Events.MESSAGE_COMMAND, { requestId: res.requestId!, command: res.data })
      }
    },
  )

  socketHandler.register(Events.REQUEST_START, (res: SocketResponse<RawMessage>) => {
    eventBus.emit(Events.REQUEST_START, { requestId: res.requestId!, data: res.data })
  })

  socketHandler.register(Events.REQUEST_COMPLETE, (res: SocketResponse<RawMessage>) => {
    eventBus.emit(Events.REQUEST_COMPLETE, { requestId: res.requestId!, data: res.data })
  })

  socketHandler.register(Events.MESSAGE_STREAM, (res: SocketResponse<RawMessage>) => {
    if (!res.data) return
    eventBus.emit(Events.MESSAGE_STREAM, { requestId: res.requestId!, data: res.data })
  })

  socketHandler.register(Events.MESSAGE_COMPLETE, (res: SocketResponse<boolean>) => {
    eventBus.emit(Events.MESSAGE_COMPLETE, { requestId: res.requestId! })
  })

  socketHandler.register(Events.MESSAGE_CANCELLED, (res: SocketResponse) => {
    eventBus.emit(Events.MESSAGE_CANCELLED, { requestId: res.requestId! })
  })

  socketHandler.register(Events.MESSAGE_ERROR, (res: SocketResponse) => {
    eventBus.emit(Events.MESSAGE_ERROR, res.message || 'Unknown error')
  })

  socketHandler.register(Events.TASK_UPDATED, (res: SocketResponse) => {
    eventBus.emit(Events.TASK_UPDATED, res.data)
  })

  socketHandler.register(Events.PERSONALITY_UPDATED, (res: SocketResponse) => {
    eventBus.emit(Events.PERSONALITY_UPDATED, res.data)
  })

  socketHandler.register(Events.TERMINAL_SESSION_CREATED, (res: SocketResponse) => {
    eventBus.emit(Events.TERMINAL_SESSION_CREATED, res.data)
  })

  socketHandler.register(Events.TERMINAL_SESSION_CLOSED, (res: SocketResponse) => {
    eventBus.emit(Events.TERMINAL_SESSION_CLOSED, res.data)
  })

  socketHandler.register(Events.TERMINAL_STATUS_CHANGED, (res: SocketResponse) => {
    eventBus.emit(Events.TERMINAL_STATUS_CHANGED, res.data)
  })
  socketHandler.register(Events.WINDOW_STATE_CHANGE, (res: SocketResponse) => {
    eventBus.emit(Events.WINDOW_STATE_CHANGE, res.data)
  })

  socketHandler.register(Events.TERMINAL_OUTPUT, (res: SocketResponse) => {
    eventBus.emit(Events.TERMINAL_OUTPUT, res.data)
  })

  socketHandler.register(Events.SUMMARY_START, (res: SocketResponse) => {
    eventBus.emit(Events.SUMMARY_START, res.data)
  })

  socketHandler.register(Events.SUMMARY_COMPLETE, (res: SocketResponse) => {
    eventBus.emit(Events.SUMMARY_COMPLETE, res.data)
  })

  socketHandler.register('position_reset', (res: SocketResponse) => {
    eventBus.emit('position_reset', res.data)
  })

  socketHandler.register('focus_input', (res: SocketResponse) => {
    eventBus.emit('focus_input', res.data)
  })

  socketHandler.register(
    'toggle_character_visibility',
    (res: SocketResponse<{ hidden: boolean }>) => {
      eventBus.emit('toggle_character_visibility', res.data)
    },
  )

  socketHandler.register(Events.TOKEN_USAGE, (res: SocketResponse) => {
    eventBus.emit(Events.TOKEN_USAGE, res.data)
  })

  socketHandler.register(Events.SOCKET_READY, (res: SocketResponse) => {
    eventBus.emit(Events.SOCKET_READY, res.data)
  })

  // Buffer消息相关事件
  socketHandler.register(Events.BUFFER_MESSAGE_ADDED, (res: SocketResponse) => {
    eventBus.emit(Events.BUFFER_MESSAGE_ADDED, res.data)
  })

  socketHandler.register(Events.BUFFER_MESSAGE_CONSUMED, (res: SocketResponse) => {
    eventBus.emit(Events.BUFFER_MESSAGE_CONSUMED, res.data)
  })

  socketHandler.register(Events.BUFFER_MESSAGE_CANCELLED, (res: SocketResponse) => {
    eventBus.emit(Events.BUFFER_MESSAGE_CANCELLED, res.data)
  })

  // 处理 AI 调用的弹窗创建命令
  socketHandler.register(
    'command:popup',
    (
      res: SocketResponse<{
        id: string
        content: string
        title: string
        width: number
        height: number
        x: number
        y: number
        duration: number
        popupType: string
      }>,
    ) => {
      if (res.data) {
        // 通过 IPC 通知主进程创建弹窗
        ipcCreatePopup(res.data)
      }
    },
  )

  // 处理 AI 调用的审查窗口创建命令
  socketHandler.register(
    'command:review',
    (
      res: SocketResponse<{
        requestId: string
        toolName: string
        toolArgs: Record<string, unknown>
        riskDescription: string
        timeout: number
      }>,
    ) => {
      if (res.data) {
        // 通过 IPC 通知主进程创建审查窗口
        ipcCreateReview(res.data)
      }
    },
  )

  // 处理截图请求 - 通过 IPC 调用主进程 desktopCapturer
  socketHandler.register(
    'screenshot:request',
    async (
      res: SocketResponse<{ displayId?: number; format?: 'png' | 'jpeg'; quality?: number }> & {
        requestId?: string
      },
    ) => {
      if (!res.data) return
      const requestId = (res as any).requestId
      try {
        const result = await window.api.screenshot.capture({
          displayId: res.data.displayId,
          format: res.data.format || 'jpeg',
          quality: res.data.quality || 75,
        })

        // 通过 socket 返回结果给 Server
        client.value?.send({
          command: 'screenshot:result',
          data: result,
          requestId: requestId || `screenshot-${Date.now()}`,
        } as any)
      } catch (error: any) {
        client.value?.send({
          command: 'screenshot:result',
          data: { success: false, error: error.message },
          requestId: requestId || `screenshot-${Date.now()}`,
        } as any)
      }
    },
  )

  // 连接成功后同步后台状态
  syncLoadingState()
}

const disconnect = () => {
  client.value?.disconnect()
  client.value = null
  connected.value = false
}

const send = (content: string, requestId: string) => {
  client.value?.send({
    command: content.startsWith('/') ? 'command' : 'chat',
    data: { message: content },
    requestId,
  })
}

const sendTTS = async (
  text: string,
  speed: string,
  batchContext?: { batchId: string; batchIndex: number; isBatchComplete: boolean },
): Promise<TTSResult | null> => {
  try {
    const response = await fetch(`http://localhost:${httpPort}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, speed, ...batchContext }),
    })
    const result = await response.json()
    if (result.code === 200 && result.data) {
      return {
        audioBase64: result.data.audioBase64,
        duration: result.data.duration,
      }
    }
    return null
  } catch (error) {
    return null
  }
}

const sendModelState = (command: string, data: any) => {
  if (!client.value || !connected.value) {
    console.warn('[useSocket] Socket not connected, cannot send model state')
    return
  }
  client.value.send({
    command,
    data,
    requestId: `model-${Date.now()}`,
  })
}

const cancelChat = (requestId: string) => {
  if (!client.value || !connected.value) {
    console.warn('[useSocket] Socket not connected, cannot cancel chat')
    return
  }

  client.value.send({
    command: 'chat_cancel',
    data: { requestId },
    requestId: `chat-cancel-${Date.now()}`,
  })
}

const cancelBufferMessage = (messageId: string) => {
  if (!client.value || !connected.value) {
    console.warn('[useSocket] Socket not connected, cannot cancel buffer message')
    return Promise.reject(new Error('Socket not connected'))
  }

  return sendCommand<{ messageId: string; cancelled: boolean }>('buffer_cancel', { messageId })
}

const sendCommand = <T = unknown>(command: string, data: unknown = {}): Promise<T> => {
  return new Promise((resolve, reject) => {
    if (!client.value || !connected.value) {
      reject(new Error('Socket not connected'))
      return
    }
    const requestId = `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const socketHandler = client.value.getHandler()
    socketHandler.register(`req:${requestId}`, (res: SocketResponse<T>) => {
      if (res.code === 200 && res.data) {
        resolve(res.data)
      } else {
        reject(new Error(res.message || 'Command failed'))
      }
    })
    client.value.send({
      command,
      data,
      requestId,
    })
  })
}

const getChatHistory = async (
  params: HistoryLoadParams = {},
): Promise<{ history: RawMessage[]; hasMore?: boolean }> => {
  console.log('[useSocket] getChatHistory 调用, params:', params)
  const result = await sendCommand<{ history: RawMessage[]; hasMore?: boolean }>(
    'get_chat_history',
    params,
  )
  console.log('[useSocket] getChatHistory 返回:', result)
  return result
}

const getInstantState = async (): Promise<{
  pad: { pleasure: number; arousal: number; dominance: number }
  bigFive: {
    extraversion: number
    agreeableness: number
    openness: number
    conscientiousness: number
    neuroticism: number
  }
  personalityDescription: string
  moodDescription: string
  longTermMemory: string[]
  summary: string
  conversationCountSinceLastSummary: number
  emotions: any[]
  currentExpressions: any[]
  currentAction: any
  activity: string
  lastUpdateTime: number
}> => {
  return sendCommand('get_instant_state')
}

const getModelConfig = async (): Promise<Live2DModelConfig> => {
  // 使用IPC直接从main进程获取，不再通过Server中转
  return ipcGetModelConfig()
}

/**
 * 设置窗口置顶状态
 * 已迁移到 IPC 实现
 */
const setWindowTop = async (alwaysOnTop: boolean): Promise<void> => {
  await ipcSetWindowTop(alwaysOnTop)
}

/**
 * 切换窗口置顶状态
 * 已迁移到 IPC 实现
 */
const toggleWindowTop = async (): Promise<void> => {
  await ipcToggleWindowTop()
}

/**
 * 获取窗口状态
 * 已迁移到 IPC 实现
 */
const getWindowState = async (): Promise<{ alwaysOnTop: boolean }> => {
  return ipcGetWindowState()
}

let cacheCurrentState: boolean | null = null
/**
 * 设置鼠标穿透状态
 * 已迁移到 IPC 实现
 */
const setIgnoreMouse = async (state: boolean, option?: any, ..._tag): Promise<void> => {
  if (cacheCurrentState === state) return
  cacheCurrentState = state
  await ipcSetIgnoreMouse(state, option)
}

/**
 * 重置窗口位置
 * 已迁移到 IPC 实现
 */
const resetWindowPosition = async (): Promise<void> => {
  await ipcResetWindowPosition()
}

/**
 * 重新打开弹窗
 * 已迁移到 IPC 实现
 */
const reopenPopup = async (
  id: string,
  params?: {
    title?: string
    content?: string
    width?: number
    height?: number
    x?: number
    y?: number
    popupType?: string
  },
): Promise<void> => {
  await ipcReopenPopup(id, params)
}

const onEvent = <T = unknown>(event: string, handler: (data: T) => void): (() => void) => {
  const socketHandler = client.value?.getHandler()
  if (!socketHandler) return () => {}
  socketHandler.register(event, (res: SocketResponse<T>) => {
    if (res.data) handler(res.data)
  })
  return () => socketHandler.unregister(event)
}

const getTaskList = async (): Promise<{
  success: boolean
  message: string
  tasks?: any[]
  currentTask?: any
  suspendedTask?: any
}> => {
  return sendCommand('task:list')
}

const getContextTokens = async (): Promise<{
  totalTokens: number
  truncatedTokens: number
  messageCount: number
  roundCount: number
}> => {
  return sendCommand('get_context_tokens')
}

/**
 * 获取当前活跃的请求列表
 */
const getActiveRequests = async (): Promise<{
  activeRequestIds: string[]
  hasActiveRequests: boolean
  streamingMessages?: Record<
    string,
    Array<{
      id: string
      type: 'human' | 'ai' | 'tool'
      content: string
      toolCalls?: any[]
      status?: 'streaming' | 'loading' | 'complete'
      timestamp: number
    }>
  >
}> => {
  return sendCommand('get_active_requests')
}

/**
 * 同步后台loading状态
 * 页面刷新后重新连接时调用，恢复loading状态和requestId
 */
const syncLoadingState = async (): Promise<void> => {
  try {
    const { activeRequestIds, hasActiveRequests, streamingMessages } = await getActiveRequests()
    if (hasActiveRequests && activeRequestIds.length > 0) {
      const requestId = activeRequestIds[0]
      // 恢复loading状态
      eventBus.emit(Events.REQUEST_START, { requestId })

      // 恢复流式消息
      if (streamingMessages && streamingMessages[requestId]) {
        const messages = streamingMessages[requestId]
        for (const msg of messages) {
          const message: Message = {
            id: msg.id,
            type: msg.type,
            content: msg.content,
            toolCalls: msg.toolCalls,
            status: msg.status,
            timestamp: msg.timestamp,
          }
          eventBus.emit(Events.MESSAGE_STREAM, { requestId, data: message })
        }
      }
    }
  } catch (error) {
    console.warn('[useSocket] 同步loading状态失败:', error)
  }
}

export function useSocket() {
  return {
    client,
    connected,
    connect,
    disconnect,
    send,
    sendTTS,
    sendModelState,
    cancelChat,
    cancelBufferMessage,
    sendCommand,
    getChatHistory,
    getInstantState,
    getModelConfig,
    // 窗口操作已迁移到 IPC
    setWindowTop,
    toggleWindowTop,
    getWindowState,
    setIgnoreMouse,
    resetWindowPosition,
    reopenPopup,
    onEvent,
    getTaskList,
    getContextTokens,
    getActiveRequests,
    syncLoadingState,
  }
}
