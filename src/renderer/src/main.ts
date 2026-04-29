import './assets/cursor-fix.css'
import './assets/main.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { ensureCubismFrameworkInitialized } from './live2d/CubismFrameworkInit'

// 过滤 Live2D Cubism Core 的日志
const originalConsoleError = console.error
console.error = (...args: any[]) => {
  const message = args[0]?.toString() || ''
  if (message.includes('[CSM]') && message.includes('not supported mask count')) {
    return // 忽略 mask count 错误
  }
  originalConsoleError.apply(console, args)
}

const originalConsoleWarn = console.warn
console.warn = (...args: any[]) => {
  const message = args[0]?.toString() || ''
  if (message.includes('[CSM]')) {
    return // 忽略所有 CSM 警告
  }
  originalConsoleWarn.apply(console, args)
}

const pinia = createPinia()

// 初始化 CubismFramework（必须在 Live2DCubismCore 加载后、Vue mount 前调用）
ensureCubismFrameworkInitialized()

createApp(App).use(pinia).mount('#app')
