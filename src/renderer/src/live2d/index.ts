export {
  CubismModelWrapper,
  PriorityNone,
  PriorityIdle,
  PriorityNormal,
  PriorityForce,
} from './CubismModelWrapper'
export { TextureManager, TextureInfo } from './TextureManager'
export { ensureCubismFrameworkInitialized, disposeCubismFramework } from './CubismFrameworkInit'

/** 碰撞检测区域宽度比例 */
export const HIT_AREA_WIDTH_RATIO = 0.35
/** 碰撞检测区域高度比例 */
export const HIT_AREA_HEIGHT_RATIO = 0.9
