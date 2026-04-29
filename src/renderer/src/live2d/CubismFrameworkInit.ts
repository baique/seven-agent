import { CubismFramework, LogLevel, Option } from '@cubism/live2dcubismframework'

/** CubismFramework是否已初始化 */
let _initialized = false

/**
 * 初始化CubismFramework
 * 必须在Live2DCubismCore加载完成后调用
 * 全局只需调用一次
 */
export function ensureCubismFrameworkInitialized(): void {
  if (_initialized) return

  if (!CubismFramework.isStarted()) {
    const option: Option = new Option()
    option.logFunction = (message: string) => {
      if (message.includes('[CSM]') && message.includes('not supported mask count')) return
      // console.log('[CubismFW]', message)
    }
    option.loggingLevel = LogLevel.LogLevel_Warning
    CubismFramework.startUp(option)
  }

  if (!CubismFramework.isInitialized()) {
    CubismFramework.initialize()
  }

  _initialized = true
  // console.log('[CubismFrameworkInit] Cubism SDK initialized')
}

/**
 * 释放CubismFramework
 * 应用退出时调用
 */
export function disposeCubismFramework(): void {
  if (_initialized) {
    CubismFramework.dispose()
    _initialized = false
    // console.log('[CubismFrameworkInit] Cubism SDK disposed')
  }
}
