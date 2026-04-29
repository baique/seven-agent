import markdownit from 'markdown-it'
import { Typography } from 'ant-design-vue'
import { BubbleProps } from 'ant-design-x-vue'

const md = markdownit({ html: true, breaks: true })

/**
 * 将字面的 \n 字符串转换为真正的换行符
 */
const normalizeNewlines = (content: string): string => {
  return content.replace(/\\n/g, '\n')
}

export const renderMarkdown: BubbleProps['messageRender'] = (content) => {
  return <Typography>{buildMsg(content)}</Typography>
}

export const buildMsg = (content: string) => {
  return <div class="msg-markdown-content" v-html={md.render(normalizeNewlines(content))} />
}
