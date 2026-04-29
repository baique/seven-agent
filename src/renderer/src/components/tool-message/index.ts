import DefaultToolMessage from './DefaultToolMessage.vue'
import NotificationToolMessageComponent from './NotificationToolMessage.vue'
import ExtInvokeToolMessageComponent from './ExtInvokeToolMessage.vue'
import type { Component } from 'vue'

export const toolMessageRenderers: Record<string, Component> = {
  open_window: NotificationToolMessageComponent,
  ext_invoke: ExtInvokeToolMessageComponent,
  default: DefaultToolMessage,
}

export {
  DefaultToolMessage,
  NotificationToolMessageComponent as NotificationToolMessage,
  ExtInvokeToolMessageComponent as ExtInvokeToolMessage,
}
