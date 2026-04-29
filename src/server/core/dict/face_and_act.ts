export type CharacterStateType = 1 | 2 | 3

export type StateDuration = 'persistent' | 'instant'

export interface CharacterStateDefinition {
  id: string
  type: CharacterStateType
  duration: StateDuration
  desc?: string
}

export const CHARACTER_STATES: Record<string, CharacterStateDefinition> = {
  开心: { id: '开心', type: 1, duration: 'instant', desc: '表示开心' },
  星星眼: { id: '星星眼', type: 1, duration: 'instant', desc: '欣喜，收到惊喜，看到很喜欢的东西' },
  满眼爱意: {
    id: '满眼爱意',
    type: 1,
    duration: 'instant',
    desc: '表示对某个人的爱意，通常不会轻易表达',
  },
  脸红: { id: '脸红', type: 1, duration: 'instant', desc: '在感到害羞,被调戏,出糗的时候使用' },
  脸黑: { id: '脸黑', type: 1, duration: 'instant' },
  汗: { id: '汗', type: 1, duration: 'instant', desc: '表示无语，表示尴尬' },
  愤怒: { id: '愤怒', type: 1, duration: 'instant' },
  唱歌: { id: '唱歌', type: 2, duration: 'persistent' },
  停止唱歌: { id: '停止唱歌', type: 2, duration: 'instant' },
  打招呼: { id: '打招呼', type: 2, duration: 'instant' },
  停止打招呼: { id: '停止打招呼', type: 2, duration: 'instant' },
  摆出猫猫爪姿势: { id: '摆出猫猫爪姿势', type: 2, duration: 'persistent', desc: '卖萌' },
  收回猫猫爪姿势: { id: '收回猫猫爪姿势', type: 2, duration: 'instant' },
  比心: { id: '比心', type: 2, duration: 'persistent', desc: '夸张的表达爱意' },
  取消比心: { id: '取消比心', type: 2, duration: 'instant' },
  跪坐: { id: '跪坐', type: 2, duration: 'persistent' },
  起身: { id: '起身', type: 2, duration: 'instant' },
  脱掉外套: { id: '脱掉外套', type: 2, duration: 'persistent', desc: '可以用来调戏用户' },
  穿外套: { id: '穿外套', type: 2, duration: 'instant' },
  歪嘴: { id: '歪嘴', type: 2, duration: 'persistent', desc: '表示不屑不满' },
  不歪嘴: { id: '不歪嘴', type: 2, duration: 'instant' },
  鼓嘴: { id: '鼓嘴', type: 2, duration: 'persistent', desc: '嘟嘟嘴，鼓起嘴，表示不满' },
  不鼓嘴: { id: '不鼓嘴', type: 2, duration: 'instant' },
  张开嘴巴: { id: '张开嘴巴', type: 2, duration: 'persistent', desc: '嘴巴张到最大' },
  闭上嘴巴: { id: '闭上嘴巴', type: 2, duration: 'instant' },
  流泪: { id: '流泪', type: 2, duration: 'instant' },
  挥手: { id: '挥手', type: 2, duration: 'instant', desc: '**友好**的打招呼/再见' },
  平静: { id: '平静', type: 3, duration: 'persistent', desc: '初始情绪状态' },
  兴奋: { id: '兴奋', type: 3, duration: 'persistent', desc: '对某事感到兴奋' },
  期待: { id: '期待', type: 3, duration: 'persistent', desc: '期待某事发生' },
  害羞: { id: '害羞', type: 3, duration: 'persistent', desc: '感到害羞' },
  撒娇: { id: '撒娇', type: 3, duration: 'persistent', desc: '撒娇状态' },
  生气: { id: '生气', type: 3, duration: 'persistent', desc: '生气了' },
}

export const getStateById = (id: string): CharacterStateDefinition | undefined => {
  return CHARACTER_STATES[id]
}

export const getAllStates = (): CharacterStateDefinition[] => {
  return Object.values(CHARACTER_STATES)
}

export const getStatesByType = (type: CharacterStateType): CharacterStateDefinition[] => {
  return Object.values(CHARACTER_STATES).filter((state) => state.type === type)
}

const formatState = (s: CharacterStateDefinition): string => {
  let str = `- ${s.id}`
  if (s.desc) str += `：${s.desc}`
  return str
}

export function buildAllPrompt(): string {
  const faces = getStatesByType(1).map(formatState).join('\n')

  const persistentActs = getStatesByType(2)
    .filter((s) => s.duration === 'persistent')
    .map(formatState)
    .join('\n')
  const instantActs = getStatesByType(2)
    .filter((s) => s.duration === 'instant')
    .map(formatState)
    .join('\n')

  const emotions = getStatesByType(3).map(formatState).join('\n')

  return `## 表情
${faces}

${emotions}
## 动作

** 要主动执行反向动作取消。例如：跪坐后需要起身、比心后需要取消比心等
${persistentActs}

${instantActs}`
}
