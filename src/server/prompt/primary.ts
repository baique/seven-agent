// 人格主体

import { buildAllPrompt } from '../core/dict/face_and_act'
import { buildPromptFromTemplate } from './template'

/**
 * 构建完整人格
 * 系统
 * 主体
 * 灵魂
 * 状态
 */
export const buildPersonPrompt = async () => {
  const [faceList] = await Promise.all([buildAllPrompt()])
  return await buildPromptFromTemplate(faceList)
}
