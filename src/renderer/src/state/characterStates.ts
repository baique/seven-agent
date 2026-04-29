export type CharacterStateType = 1 | 2 | 3

export type StateDuration = 'persistent' | 'instant'

export interface StateParam {
  name: string
  value: number
  defValue: number
}

export interface CharacterStateDefinition {
  id: string
  type: CharacterStateType
  active: StateParam[]
  default: StateParam[]
  duration?: StateDuration
  desc?: string
}

export const CHARACTER_STATES: Record<string, CharacterStateDefinition> = {
  开心: {
    id: '开心',
    type: 1,
    active: [{ name: 'Param102', value: 1, defValue: 0 }],
    default: [{ name: 'Param102', value: 0, defValue: 0 }],

    desc: '表示开心',
  },
  星星眼: {
    id: '星星眼',
    type: 1,
    active: [{ name: 'Param101', value: 1, defValue: 0 }],
    default: [{ name: 'Param101', value: 0, defValue: 0 }],
    desc: '欣喜，收到惊喜，看到很喜欢的东西',
  },
  满眼爱意: {
    id: '满眼爱意',
    type: 1,
    active: [{ name: 'Param103', value: 1, defValue: 0 }],
    default: [{ name: 'Param103', value: 0, defValue: 0 }],
    desc: '表示对某个人的爱意，通常不会轻易表达',
  },
  脸红: {
    id: '脸红',
    type: 1,
    active: [{ name: 'Param84', value: 1, defValue: 0 }],
    default: [{ name: 'Param84', value: 0, defValue: 0 }],

    desc: '在感到害羞,被调戏,出糗的时候使用',
  },
  脸黑: {
    id: '脸黑',
    type: 1,
    active: [{ name: 'Param85', value: 1, defValue: 0 }],
    default: [{ name: 'Param85', value: 0, defValue: 0 }],
  },
  汗: {
    id: '汗',
    type: 1,
    active: [{ name: 'Param79', value: 1, defValue: 0 }],
    default: [{ name: 'Param79', value: 0, defValue: 0 }],

    desc: '表示无语，表示尴尬',
  },
  愤怒: {
    id: '愤怒',
    type: 1,
    active: [{ name: 'Param80', value: 1, defValue: 0 }],
    default: [{ name: 'Param80', value: 0, defValue: 0 }],
  },
  唱歌: {
    id: '唱歌',
    type: 2,
    active: [{ name: 'Param69', value: 1, defValue: 0 }],
    default: [{ name: 'Param69', value: 0, defValue: 0 }],
    desc: '心情愉悦的时候会哼唱起来，哼唱的时候使用',
  },
  停止唱歌: {
    id: '停止唱歌',
    type: 2,
    active: [{ name: 'Param69', value: 0, defValue: 0 }],
    default: [{ name: 'Param69', value: 0, defValue: 0 }],
  },
  打招呼: {
    id: '打招呼',
    type: 2,
    active: [{ name: 'Param70', value: 1, defValue: 0 }],
    default: [{ name: 'Param70', value: 0, defValue: 0 }],
  },
  停止打招呼: {
    id: '停止打招呼',
    type: 2,
    active: [{ name: 'Param70', value: 0, defValue: 0 }],
    default: [{ name: 'Param70', value: 0, defValue: 0 }],
  },
  摆出猫猫爪姿势: {
    id: '摆出猫猫爪姿势',
    type: 2,
    active: [{ name: 'Param72', value: 1, defValue: 0 }],
    default: [{ name: 'Param72', value: 0, defValue: 0 }],

    desc: '卖萌',
  },
  收回猫猫爪姿势: {
    id: '收回猫猫爪姿势',
    type: 2,
    active: [{ name: 'Param72', value: 0, defValue: 0 }],
    default: [{ name: 'Param72', value: 0, defValue: 0 }],
  },
  比心: {
    id: '比心',
    type: 2,
    active: [{ name: 'Param74', value: 1, defValue: 0 }],
    default: [{ name: 'Param74', value: 0, defValue: 0 }],

    desc: '表达爱意,表达完就要取消比心',
  },
  取消比心: {
    id: '取消比心',
    type: 2,
    active: [{ name: 'Param74', value: 0, defValue: 0 }],
    default: [{ name: 'Param74', value: 0, defValue: 0 }],
  },
  举起鞭子: {
    id: '举起鞭子',
    type: 2,
    active: [{ name: 'Param76', value: 1, defValue: 0 }],
    default: [{ name: 'Param76', value: 0, defValue: 0 }],

    desc: '会让你看起来气势汹汹',
  },
  收起鞭子: {
    id: '收起鞭子',
    type: 2,
    active: [{ name: 'Param76', value: 0, defValue: 0 }],
    default: [{ name: 'Param76', value: 0, defValue: 0 }],
  },
  跪坐: {
    id: '跪坐',
    type: 2,
    active: [{ name: 'Param88', value: 1, defValue: 0 }],
    default: [{ name: 'Param88', value: 0, defValue: 0 }],
  },
  起身: {
    id: '起身',
    type: 2,
    active: [{ name: 'Param88', value: 0, defValue: 0 }],
    default: [{ name: 'Param88', value: 0, defValue: 0 }],
  },
  脱掉外套: {
    id: '脱掉外套',
    type: 2,
    active: [{ name: 'Param109', value: 1, defValue: 0 }],
    default: [{ name: 'Param109', value: 0, defValue: 0 }],

    desc: '可以用来调戏用户',
  },
  穿外套: {
    id: '穿外套',
    type: 2,
    active: [{ name: 'Param109', value: 0, defValue: 0 }],
    default: [{ name: 'Param109', value: 0, defValue: 0 }],
  },
  歪嘴: {
    id: '歪嘴',
    type: 2,
    active: [{ name: 'Param', value: 1, defValue: 0 }],
    default: [{ name: 'Param', value: 0, defValue: 0 }],

    desc: '表示不屑不满',
  },
  不歪嘴: {
    id: '不歪嘴',
    type: 2,
    active: [{ name: 'Param', value: 0, defValue: 0 }],
    default: [{ name: 'Param', value: 0, defValue: 0 }],
  },
  鼓嘴: {
    id: '鼓嘴',
    type: 2,
    active: [{ name: 'Param2', value: 1, defValue: 0 }],
    default: [{ name: 'Param2', value: 0, defValue: 0 }],

    desc: '嘟嘟嘴，鼓起嘴，表示不满',
  },
  不鼓嘴: {
    id: '不鼓嘴',
    type: 2,
    active: [{ name: 'Param2', value: 0, defValue: 0 }],
    default: [{ name: 'Param2', value: 0, defValue: 0 }],
  },
  张开嘴巴: {
    id: '张开嘴巴',
    type: 2,
    active: [{ name: 'ParamMouthOpenY', value: 1, defValue: 0 }],
    default: [{ name: 'ParamMouthOpenY', value: 0, defValue: 0 }],

    desc: '嘴巴张到最大',
  },
  闭上嘴巴: {
    id: '闭上嘴巴',
    type: 2,
    active: [{ name: 'Param2', value: 0, defValue: 0 }],
    default: [{ name: 'Param2', value: 0, defValue: 0 }],
  },
  流泪: {
    id: '流泪',
    type: 2,
    active: [{ name: 'Param100', value: 1, defValue: 0 }],
    default: [{ name: 'Param100', value: 0, defValue: 0 }],
  },
  挥手: {
    id: '挥手',
    type: 2,
    active: [{ name: 'Param70', value: 1, defValue: 0 }],
    default: [{ name: 'Param70', value: 0, defValue: 0 }],
  },
  平静: {
    id: '平静',
    type: 3,
    active: [
      { name: 'ParamMouthForm', value: -0.4, defValue: 0 },
      { name: 'Param110', value: 0.95, defValue: 0 },
      { name: 'Param112', value: 0.95, defValue: 0 },
    ],
    default: [],

    desc: '初始情绪状态',
  },
  摇晃身体: {
    id: '摇晃身体',
    type: 2,
    active: [
      { name: 'ParamBodyAngleX', value: 1, defValue: 0 },
      { name: 'ParamBodyAngleY', value: 0.5, defValue: 0 },
    ],
    default: [
      { name: 'ParamBodyAngleX', value: 0, defValue: 0 },
      { name: 'ParamBodyAngleY', value: 0, defValue: 0 },
    ],
    desc: '轻微摇晃身体',
  },
  兴奋: {
    id: '兴奋',
    type: 3,
    active: [
      { name: 'ParamEyeLSmile', value: 0.8, defValue: 0 },
      { name: 'ParamEyeRSmile', value: 0.8, defValue: 0 },
      { name: 'Param103', value: 0.5, defValue: 0 },
    ],
    default: [
      { name: 'ParamEyeLSmile', value: 0, defValue: 0 },
      { name: 'ParamEyeRSmile', value: 0, defValue: 0 },
      { name: 'Param103', value: 0, defValue: 0 },
    ],
    duration: 'persistent',
    desc: '对某事感到兴奋',
  },
  期待: {
    id: '期待',
    type: 3,
    active: [
      { name: 'ParamEyeBallY', value: -0.3, defValue: 0 },
      { name: 'Param83', value: 0.7, defValue: 0 },
    ],
    default: [
      { name: 'ParamEyeBallY', value: 0, defValue: 0 },
      { name: 'Param83', value: 0, defValue: 0 },
    ],
    duration: 'persistent',
    desc: '期待某事发生',
  },
  害羞: {
    id: '害羞',
    type: 3,
    active: [
      { name: 'Param84', value: 1, defValue: 0 },
      { name: 'Param37', value: 0.3, defValue: 0 },
    ],
    default: [
      { name: 'Param84', value: 0, defValue: 0 },
      { name: 'Param37', value: 0, defValue: 0 },
    ],
    duration: 'persistent',
    desc: '感到害羞',
  },
  撒娇: {
    id: '撒娇',
    type: 3,
    active: [{ name: 'ParamEyeLSmile', value: 0.5, defValue: 0 }],
    default: [{ name: 'ParamEyeLSmile', value: 0, defValue: 0 }],
    duration: 'persistent',
    desc: '撒娇状态',
  },
  生气: {
    id: '生气',
    type: 3,
    active: [
      { name: 'Param80', value: 0, defValue: 0 },
      { name: 'Param2', value: 0.7, defValue: 0 },
    ],
    default: [
      { name: 'Param80', value: 0, defValue: 0 },
      { name: 'Param2', value: 0, defValue: 0 },
    ],
    duration: 'persistent',
    desc: '生气了',
  },
}

export function getStateById(id: string): CharacterStateDefinition | undefined {
  return CHARACTER_STATES[id]
}

export function resolveStateCommand(
  command: Partial<StateCommandFromBackend>,
): StateCommandResolved | null {
  if (!command.id || !command.type) {
    console.warn('[resolveStateCommand] 缺少必要字段:', command)
    return null
  }

  const stateDef = getStateById(command.id)
  if (!stateDef) {
    console.warn('[resolveStateCommand] 未找到状态定义:', command.id)
    return null
  }

  const rawIntensity = command.intensity ?? 100
  const normalizedIntensity = Math.max(0, Math.min(100, rawIntensity)) / 100
  const scaledParams = stateDef.active.map((p) => ({
    ...p,
    value: p.value * normalizedIntensity,
  }))

  const duration = command.duration || 'instant'

  return {
    type: command.type,
    id: command.id,
    params: scaledParams,
    duration,
    intensity: normalizedIntensity,
  }
}

export interface StateCommandFromBackend {
  type: CharacterStateType
  id: string
  intensity?: number
  duration?: StateDuration
}

export interface StateCommandResolved {
  type: CharacterStateType
  id: string
  params: StateParam[]
  duration: StateDuration
  intensity?: number
}
