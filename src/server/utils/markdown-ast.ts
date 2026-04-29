import MarkdownIt from 'markdown-it'

/**
 * Markdown AST 节点类型
 */
export type MarkdownNodeType =
  | 'root'
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'fence'
  | 'blockquote'
  | 'list'
  | 'ordered_list'
  | 'bullet_list'
  | 'list_item'
  | 'table'
  | 'thead'
  | 'tbody'
  | 'tr'
  | 'th'
  | 'td'
  | 'strong'
  | 'em'
  | 's'
  | 'link'
  | 'image'
  | 'code_inline'
  | 'hardbreak'
  | 'softbreak'
  | 'text'
  | 'inline'
  | 'html_block'
  | 'html_inline'

/**
 * Markdown AST 节点
 */
export interface MarkdownNode {
  /** 节点类型 */
  type: MarkdownNodeType
  /** 标签名 */
  tag?: string
  /** 节点内容 */
  content?: string
  /** 节点属性 */
  attrs?: [string, string][]
  /** 子节点 */
  children?: MarkdownNode[]
  /** 节点层级信息 */
  level?: number
  /** 代码块语言 */
  info?: string
  /** 是否自闭合 */
  block?: boolean
  /** 是否隐藏 */
  hidden?: boolean
}

/**
 * TTS 文本片段
 */
export interface TTSTextSegment {
  /** 文本内容 */
  text: string
  /** 原始 markdown */
  raw: string
  /** 节点类型 */
  nodeType: MarkdownNodeType
  /** 片段后暂停时间（秒），用于TTS播放间隔 */
  pauseAfter?: number
}

/**
 * Markdown AST 解析器
 * 用于解析 LLM 响应的 markdown 内容，提取适合 TTS 的文本
 */
export class MarkdownAstParser {
  private md: MarkdownIt

  constructor() {
    this.md = new MarkdownIt({
      html: false,
      xhtmlOut: false,
      breaks: false,
      linkify: true,
      typographer: false,
    })
  }

  /**
   * 解析 markdown 文本为 AST
   * @param markdown - markdown 文本
   * @returns AST 根节点
   */
  parse(markdown: string): MarkdownNode {
    const tokens = this.md.parse(markdown, {})
    return this.buildAst(tokens)
  }

  /**
   * 提取适合 TTS 的文本段落
   * 过滤掉表格、链接、代码块等不适合 TTS 的内容
   * 支持段落、标题、列表项，并处理段落内的换行
   * @param markdown - markdown 文本
   * @returns TTS 文本片段数组
   */
  extractTTSText(markdown: string): TTSTextSegment[] {
    const ast = this.parse(markdown)
    const segments: TTSTextSegment[] = []

    this.extractFromNode(ast, segments, null)

    return segments
  }

  /**
   * 从节点递归提取 TTS 文本片段
   * @param node - 当前节点
   * @param segments - 片段数组
   * @param parentType - 父节点类型
   */
  private extractFromNode(
    node: MarkdownNode,
    segments: TTSTextSegment[],
    _parentType: MarkdownNodeType | null,
  ): void {
    // 处理段落：检查内部是否有换行需要分段
    if (node.type === 'paragraph') {
      this.extractFromParagraph(node, segments)
      return
    }

    // 处理标题：作为一个整体
    if (node.type === 'heading') {
      const text = this.getTextContent(node)
      if (text.trim()) {
        segments.push({
          text: text.trim(),
          raw: '',
          nodeType: node.type,
          pauseAfter: this.calculatePauseAfter(text.trim(), node.type),
        })
      }
      return
    }

    // 处理列表项：每项作为一个独立分段
    if (node.type === 'list_item') {
      const text = this.getTextContent(node)
      if (text.trim()) {
        segments.push({
          text: text.trim(),
          raw: '',
          nodeType: node.type,
          pauseAfter: this.calculatePauseAfter(text.trim(), node.type),
        })
      }
      return
    }

    // 递归处理子节点
    if (node.children) {
      for (const child of node.children) {
        this.extractFromNode(child, segments, node.type)
      }
    }
  }

  /**
   * 从段落节点提取文本，处理内部换行
   * 将 softbreak/hardbreak 作为分段边界
   * @param node - 段落节点
   * @param segments - 片段数组
   */
  private extractFromParagraph(node: MarkdownNode, segments: TTSTextSegment[]): void {
    if (!node.children || node.children.length === 0) return

    const parts: string[] = []
    let currentPart = ''

    for (const child of node.children) {
      // 遇到换行节点，将当前内容作为一个分段
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        if (currentPart.trim()) {
          parts.push(currentPart.trim())
        }
        currentPart = ''
      } else {
        const text = this.getTextContent(child)
        currentPart += text
      }
    }

    // 处理最后一部分
    if (currentPart.trim()) {
      parts.push(currentPart.trim())
    }

    // 为每个部分创建 segment
    for (let i = 0; i < parts.length; i++) {
      const isLastPart = i === parts.length - 1
      segments.push({
        text: parts[i],
        raw: '',
        nodeType: 'paragraph',
        // 段落内部换行后的停顿稍短，段落结束停顿正常
        pauseAfter: isLastPart ? this.calculatePauseAfter(parts[i], 'paragraph') : 0.2,
      })
    }
  }

  /**
   * 根据文本内容和节点类型计算停顿时间
   * @param text - 文本内容
   * @param nodeType - 节点类型
   * @returns 停顿时间（秒）
   */
  private calculatePauseAfter(text: string, nodeType: MarkdownNodeType): number {
    const trimmed = text.trim()
    if (!trimmed) return 0.25

    // 优先处理 [wait-n] 标记
    const waitMatch = trimmed.match(/\[wait-(\d+)\]$/i)
    if (waitMatch) {
      const ms = Math.min(3200, Math.max(800, parseInt(waitMatch[1], 10)))
      return ms / 1000
    }

    // 标题后停顿，表示段落切换
    if (nodeType === 'heading') {
      return 0.8
    }

    // 列表项后停顿，表示列表项切换
    if (nodeType === 'list_item') {
      return 0.3
    }

    const lastChar = trimmed[trimmed.length - 1]

    if (lastChar === '?' || lastChar === '？') {
      return 0.5
    }

    if (lastChar === '!' || lastChar === '！') {
      return 0.5
    }

    if (trimmed.endsWith('......') || trimmed.endsWith('……')) {
      return 0.4
    }

    if (trimmed.endsWith('...') || trimmed.endsWith('…')) {
      return 0.3
    }

    if (lastChar === '.' || lastChar === '。' || lastChar === ';') {
      return 0.3
    }

    return 0.25
  }

  /**
   * 获取节点的纯文本内容
   * @param node - AST 节点
   * @returns 纯文本内容
   */
  getTextContent(node: MarkdownNode): string {
    if (node.type === 'text' || node.type === 'code_inline') {
      return node.content || ''
    }

    if (!node.children || node.children.length === 0) {
      return ''
    }

    return node.children.map((child) => this.getTextContent(child)).join('')
  }

  /**
   * 遍历 AST 节点
   * @param node - 当前节点
   * @param callback - 回调函数
   * @param raw - 原始 markdown 片段
   */
  traverse(
    node: MarkdownNode,
    callback: (node: MarkdownNode, raw: string) => void,
    raw = '',
  ): void {
    callback(node, raw)
    if (node.children) {
      for (const child of node.children) {
        this.traverse(child, callback, raw)
      }
    }
  }

  /**
   * 查找特定类型的节点
   * @param node - AST 节点
   * @param type - 节点类型
   * @returns 匹配的节点数组
   */
  findNodesByType(node: MarkdownNode, type: MarkdownNodeType): MarkdownNode[] {
    const results: MarkdownNode[] = []
    this.traverse(node, (n) => {
      if (n.type === type) {
        results.push(n)
      }
    })
    return results
  }

  /**
   * 判断是否包含特定类型节点
   * @param node - AST 节点
   * @param type - 节点类型
   * @returns 是否包含
   */
  hasNodeType(node: MarkdownNode, type: MarkdownNodeType): boolean {
    let found = false
    this.traverse(node, (n) => {
      if (n.type === type) {
        found = true
      }
    })
    return found
  }

  /**
   * 将 markdown-it tokens 构建为 AST
   * @param tokens - markdown-it tokens
   * @returns AST 根节点
   */
  private buildAst(tokens: MarkdownIt.Token[]): MarkdownNode {
    const root: MarkdownNode = {
      type: 'root',
      children: [],
    }

    const stack: MarkdownNode[] = [root]

    for (const token of tokens) {
      if (token.type === 'inline') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        const inlineNode = this.parseInline(token)
        current.children.push(...(inlineNode.children || []))
      } else if (token.type.endsWith('_open')) {
        const nodeType = token.type.replace('_open', '') as MarkdownNodeType
        const node: MarkdownNode = {
          type: nodeType,
          tag: token.tag,
          attrs: token.attrs as [string, string][] | undefined,
          level: token.level,
          info: token.info,
          children: [],
        }
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push(node)
        stack.push(node)
      } else if (token.type.endsWith('_close')) {
        stack.pop()
      } else if (token.type === 'fence' || token.type === 'code_block') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push({
          type: token.type === 'fence' ? 'fence' : 'code',
          tag: token.tag,
          content: token.content,
          info: token.info,
          block: true,
        })
      } else if (token.type === 'hr' || token.type === 'hardbreak') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push({
          type: token.type === 'hr' ? 'hardbreak' : 'softbreak',
          tag: token.tag,
        })
      } else if (token.type === 'text') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push({
          type: 'text',
          content: token.content,
        })
      }
    }

    return root
  }

  /**
   * 解析 inline token
   * @param token - inline token
   * @returns inline 节点
   */
  private parseInline(token: MarkdownIt.Token): MarkdownNode {
    const root: MarkdownNode = {
      type: 'inline',
      children: [],
    }

    const stack: MarkdownNode[] = [root]

    for (const child of token.children || []) {
      if (child.type === 'text') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push({
          type: 'text',
          content: child.content,
        })
      } else if (child.type === 'code_inline') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push({
          type: 'code_inline',
          content: child.content,
        })
      } else if (child.type === 'softbreak') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push({
          type: 'softbreak',
        })
      } else if (child.type === 'hardbreak') {
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push({
          type: 'hardbreak',
        })
      } else if (child.type.endsWith('_open')) {
        const nodeType = child.type.replace('_open', '') as MarkdownNodeType
        const node: MarkdownNode = {
          type: nodeType,
          tag: child.tag,
          attrs: child.attrs as [string, string][] | undefined,
          children: [],
        }
        const current = stack[stack.length - 1]
        if (!current.children) {
          current.children = []
        }
        current.children.push(node)
        stack.push(node)
      } else if (child.type.endsWith('_close')) {
        stack.pop()
      }
    }

    return root
  }
}

/**
 * 创建 Markdown AST 解析器实例
 * @returns MarkdownAstParser 实例
 */
export function createMarkdownAstParser(): MarkdownAstParser {
  return new MarkdownAstParser()
}

/**
 * 快速提取适合 TTS 的文本
 * @param markdown - markdown 文本
 * @returns 纯文本数组
 */
export function extractTTSTextQuick(markdown: string): string[] {
  const parser = new MarkdownAstParser()
  return parser.extractTTSText(markdown).map((s) => s.text)
}
