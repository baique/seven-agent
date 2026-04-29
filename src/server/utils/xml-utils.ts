/**
 * XML解析工具类
 * 提供XML片段解析功能
 */

/**
 * XML元素节点类型
 */
export type ElementNode<T = Record<string, string>> = {
  type: 'element'
  tag: string
  attributes: T
  content: string
  children: ElementNode<T>[]
  start: number
  end: number | null
}

/**
 * 解析XML片段
 * 将XML字符串解析为元素节点树
 * @param input XML字符串
 * @returns 元素节点数组
 */
export function parseXMLFragments<T extends Record<string, string> = Record<string, string>>(
  input: string,
): ElementNode<T>[] {
  const tagRegex = /<[^>]+>/g

  const stack: ElementNode<T>[] = []
  const result: ElementNode<T>[] = []

  let lastIndex = 0
  let match: RegExpExecArray | null

  /**
   * 解析标签属性
   * @param tag 标签字符串
   * @returns 属性对象
   */
  function parseAttributes(tag: string): T {
    const attrs: Record<string, string> = {}
    const attrRegex = /([^\s=]+)\s*=\s*(['"])(.*?)\2/g

    let m: RegExpExecArray | null
    while ((m = attrRegex.exec(tag))) {
      attrs[m[1]] = m[3]
    }

    return attrs as T
  }

  while ((match = tagRegex.exec(input))) {
    const tag = match[0]
    const index = match.index

    if (index > lastIndex && stack.length > 0) {
      const text = input.slice(lastIndex, index)
      if (text.trim()) {
        stack[stack.length - 1].content += text
      }
    }

    const isClosing = /^<\//.test(tag)
    const isSelfClosing = /\/>$/.test(tag)

    const tagNameMatch = tag.match(/^<\/?([^\s/>]+)/)
    if (!tagNameMatch) continue

    const tagName = tagNameMatch[1]

    if (isClosing) {
      const node = stack.pop()
      if (!node) continue

      node.end = tagRegex.lastIndex

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node)
      } else {
        result.push(node)
      }
    } else {
      const node: ElementNode<T> = {
        type: 'element',
        tag: tagName,
        attributes: parseAttributes(tag),
        content: '',
        children: [],
        start: index,
        end: null,
      }

      if (isSelfClosing) {
        node.end = tagRegex.lastIndex

        if (stack.length > 0) {
          stack[stack.length - 1].children.push(node)
        } else {
          result.push(node)
        }
      } else {
        stack.push(node)
      }
    }

    lastIndex = tagRegex.lastIndex
  }

  if (lastIndex < input.length && stack.length > 0) {
    const text = input.slice(lastIndex)
    if (text.trim()) {
      stack[stack.length - 1].content += text
    }
  }

  return result
}
