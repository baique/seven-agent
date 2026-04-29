import { ref } from 'vue'

export interface ModelTransform {
  scale: number
  x: number
  y: number
}

// 防抖函数
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}

export function useModelStateSync(sendToBackend: (command: string, data: any) => void) {
  const transform = ref<ModelTransform>({
    scale: 1,
    x: 0,
    y: 0,
  })

  // 防抖后的变换更新函数（500ms 防抖）
  const debouncedUpdate = debounce((data: ModelTransform) => {
    sendToBackend('model:setTransform', data)
  }, 500)

  // 更新变换（带防抖）
  function updateTransform(data: Partial<ModelTransform>) {
    transform.value = { ...transform.value, ...data }
    debouncedUpdate(transform.value)
  }

  // 立即更新变换（不带防抖，用于初始化）
  function setTransform(data: ModelTransform) {
    transform.value = data
    sendToBackend('model:setTransform', data)
  }

  return {
    transform,
    updateTransform,
    setTransform,
  }
}
