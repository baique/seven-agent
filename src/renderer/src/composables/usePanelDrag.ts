import { onMounted, onUnmounted, ref, type Ref, watch } from 'vue'
import {
  getPanelDragOffsetX,
  getPanelDragOffsetY,
  savePanelDragOffset,
  type PanelType,
} from '@renderer/util'

/**
 * 面板拖拽偏移 composable
 * 通过 CSS 变量控制面板拖拽偏移量，不破坏原有定位机制
 * @param panelType 面板类型标识
 * @param panelRef 面板 DOM 引用
 */
export function usePanelDrag(panelType: PanelType, panelRef: Ref<HTMLElement | null>) {
  /** 当前累积偏移量（从 localStorage 恢复） */
  const offsetX = ref(getPanelDragOffsetX(panelType))
  const offsetY = ref(getPanelDragOffsetY(panelType))

  /** 是否正在拖拽 */
  const isDragging = ref(false)

  /** 拖拽起始鼠标坐标 */
  let startX = 0
  let startY = 0

  /** 拖拽起始时的面板偏移量 */
  let startOffsetX = 0
  let startOffsetY = 0

  /**
   * 更新 CSS 变量以应用偏移
   * 面板 CSS 中的 transform 会读取这些变量做叠加
   */
  const applyOffset = (x: number, y: number) => {
    const el = panelRef.value
    if (!el) return
    el.style.setProperty('--panel-drag-offset-x', `${x}px`)
    el.style.setProperty('--panel-drag-offset-y', `${y}px`)
  }

  /**
   * 处理鼠标按下，开始拖拽
   */
  const handleMouseDown = (e: MouseEvent) => {
    // 右键用于锁定切换，不触发拖拽
    if (e.button !== 0) return
    // 如果点击的是面板内部的交互元素（如按钮、链接），不触发拖拽
    const target = e.target as HTMLElement
    if (
      target.tagName === 'BUTTON' ||
      target.tagName === 'A' ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.closest('button') ||
      target.closest('a') ||
      target.closest('input') ||
      target.closest('textarea')
    ) {
      return
    }

    isDragging.value = true
    startX = e.clientX
    startY = e.clientY
    startOffsetX = offsetX.value
    startOffsetY = offsetY.value

    // 阻止默认行为避免选中文字
    e.preventDefault()
  }

  /**
   * 处理鼠标移动，计算并应用偏移
   */
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging.value) return

    const dx = e.clientX - startX
    const dy = e.clientY - startY

    offsetX.value = startOffsetX + dx
    offsetY.value = startOffsetY + dy

    applyOffset(offsetX.value, offsetY.value)
  }

  /**
   * 处理鼠标释放，保存偏移并结束拖拽
   */
  const handleMouseUp = () => {
    if (!isDragging.value) return
    isDragging.value = false

    // 保存到 localStorage
    savePanelDragOffset(panelType, offsetX.value, offsetY.value)
  }

  onMounted(() => {
    // 初始化 CSS 变量
    applyOffset(offsetX.value, offsetY.value)

    // 在面板上绑定 mousedown
    const el = panelRef.value
    if (el) {
      el.addEventListener('mousedown', handleMouseDown)
    }

    // 在 document 上绑定 move 和 up，确保拖拽不会因鼠标移出面板而中断
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  })

  onUnmounted(() => {
    const el = panelRef.value
    if (el) {
      el.removeEventListener('mousedown', handleMouseDown)
    }
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
  })

  return {
    offsetX,
    offsetY,
    isDragging,
  }
}
