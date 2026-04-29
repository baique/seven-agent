import { ref, readonly } from 'vue'

/**
 * 工具执行模式
 */
export type ToolMode = 'auto' | 'manual'

/**
 * Socket客户端接口（仅包含需要的方法）
 */
interface SocketClientLike {
  isConnected(): boolean
  send(request: { command: string; data: unknown; requestId: string }): void
}

const mode = ref<ToolMode>('manual')
let client: SocketClientLike | null = null

/**
 * 工具模式管理 composable
 */
export function useToolMode() {
  /**
   * 初始化，设置socket客户端
   */
  const init = (socketClient: SocketClientLike) => {
    client = socketClient
  }

  /**
   * 获取当前模式
   */
  const getMode = () => {
    return mode.value
  }

  /**
   * 切换模式
   */
  const toggleMode = () => {
    const newMode = mode.value === 'manual' ? 'auto' : 'manual'
    setMode(newMode)
  }

  /**
   * 设置模式
   */
  const setMode = (newMode: ToolMode) => {
    mode.value = newMode

    if (client && client.isConnected()) {
      client.send({
        command: 'tool_mode_change',
        data: { mode: newMode },
        requestId: `mode-${Date.now()}`,
      })
    }
  }

  return {
    mode: readonly(mode),
    init,
    getMode,
    setMode,
    toggleMode,
  }
}
