import { CubismDefaultParameterId } from '@cubism/cubismdefaultparameterid'
import { CubismModelSettingJson } from '@cubism/cubismmodelsettingjson'
import { BreathParameterData, CubismBreath } from '@cubism/effect/cubismbreath'
import { CubismEyeBlink } from '@cubism/effect/cubismeyeblink'
import { ICubismModelSetting } from '@cubism/icubismmodelsetting'
import { CubismIdHandle } from '@cubism/id/cubismid'
import { CubismFramework } from '@cubism/live2dcubismframework'
import { CubismMatrix44 } from '@cubism/math/cubismmatrix44'
import { CubismUserModel } from '@cubism/model/cubismusermodel'
import {
  ACubismMotion,
  BeganMotionCallback,
  FinishedMotionCallback,
} from '@cubism/motion/acubismmotion'
import { CubismMotion } from '@cubism/motion/cubismmotion'
import {
  CubismMotionQueueEntryHandle,
  InvalidMotionQueueEntryHandleValue,
} from '@cubism/motion/cubismmotionqueuemanager'
import { CubismUpdateScheduler } from '@cubism/motion/cubismupdatescheduler'
import { CubismBreathUpdater } from '@cubism/motion/cubismbreathupdater'
import { CubismLookUpdater } from '@cubism/motion/cubismlookupdater'
import { CubismEyeBlinkUpdater } from '@cubism/motion/cubismeyeblinkupdater'
import { CubismExpressionUpdater } from '@cubism/motion/cubismexpressionupdater'
import { CubismPhysicsUpdater } from '@cubism/motion/cubismphysicsupdater'
import { CubismPoseUpdater } from '@cubism/motion/cubismposeupdater'
import { LookParameterData, CubismLook } from '@cubism/effect/cubismlook'
import { CubismLogError } from '@cubism/utils/cubismdebug'
import { TextureManager, TextureInfo } from './TextureManager'

/** 动作优先级常量 */
export const PriorityNone = 0
export const PriorityIdle = 1
export const PriorityNormal = 2
export const PriorityForce = 3

/** 碰撞检测区域宽度比例 */
const HIT_AREA_WIDTH_RATIO = 0.35
/** 碰撞检测区域高度比例 */
const HIT_AREA_HEIGHT_RATIO = 0.9

/** 着色器文件路径 */
const SHADER_PATH = '/shaders/'

/**
 * Live2D模型包装器
 * 继承CubismUserModel，提供模型加载、更新、渲染和交互功能
 * 替代pixi-live2d-display，直接使用官方Cubism SDK
 */
export class CubismModelWrapper extends CubismUserModel {
  private _modelSetting: ICubismModelSetting | null = null
  private _modelHomeDir = ''
  private _userTimeSeconds = 0.0
  private _eyeBlinkIds: CubismIdHandle[] = []
  private _lipSyncIds: CubismIdHandle[] = []
  private _motions: Map<string, ACubismMotion> = new Map()
  private _expressions: Map<string, ACubismMotion> = new Map()
  private _idParamAngleX: CubismIdHandle
  private _idParamAngleY: CubismIdHandle
  private _idParamAngleZ: CubismIdHandle
  private _idParamBodyAngleX: CubismIdHandle
  private _look: CubismLook | null = null
  private _updateScheduler: CubismUpdateScheduler
  private _motionUpdated = false
  private _textureManager: TextureManager | null = null
  private _gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
  private _textureCount = 0
  private _expressionCount = 0
  private _motionCount = 0
  private _allMotionCount = 0
  private _canvasWidth = 0
  private _canvasHeight = 0
  private _loadComplete = false
  private _loadResolve: (() => void) | null = null
  private _lastTimeSeconds = 0
  private _frameCount = 0
  /** 外部参数覆盖层（在物理系统之后应用，优先级最高） */
  private _externalParams: Map<string, number> = new Map()
  /** 外部参数输入层（在物理系统之前应用，作为物理系统的输入） */
  private _externalInputParams: Map<string, number> = new Map()

  /** 模型加载完成回调 */
  onLoaded?: () => void

  constructor() {
    super()
    this._updateScheduler = new CubismUpdateScheduler()
    this._motionUpdated = false

    this._idParamAngleX = CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamAngleX)
    this._idParamAngleY = CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamAngleY)
    this._idParamAngleZ = CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamAngleZ)
    this._idParamBodyAngleX = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamBodyAngleX,
    )
  }

  /** 模型是否加载完成 */
  get isLoaded(): boolean {
    return this._loadComplete
  }

  /** 获取模型坐标系宽度（归一化值，如1） */
  get modelWidth(): number {
    return this._model ? this._model.getCanvasWidth() : 1
  }

  /** 获取模型坐标系高度（归一化值，如1.6） */
  get modelHeight(): number {
    return this._model ? this._model.getCanvasHeight() : 1
  }

  /** 获取WebGL画布宽度（像素值） */
  get canvasWidth(): number {
    return this._canvasWidth
  }

  /** 获取WebGL画布高度（像素值） */
  get canvasHeight(): number {
    return this._canvasHeight
  }

  /** 获取模型矩阵的X轴缩放 */
  get modelMatrixScaleX(): number {
    return this._modelMatrix ? this._modelMatrix.getScaleX() : 1
  }

  /** 获取模型矩阵的Y轴缩放 */
  get modelMatrixScaleY(): number {
    return this._modelMatrix ? this._modelMatrix.getScaleY() : 1
  }

  /** 获取表情名称列表 */
  getExpressionNames(): string[] {
    return Array.from(this._expressions.keys())
  }

  /** 获取动作组名称列表 */
  getMotionGroupNames(): string[] {
    if (!this._modelSetting) return []
    const groups: string[] = []
    const count = this._modelSetting.getMotionGroupCount()
    for (let i = 0; i < count; i++) {
      groups.push(this._modelSetting.getMotionGroupName(i))
    }
    return groups
  }

  /** 获取指定动作组的动作数量 */
  getMotionCount(group: string): number {
    if (!this._modelSetting) return 0
    return this._modelSetting.getMotionCount(group)
  }

  /**
   * 从URL加载模型
   * @param modelUrl model3.json的URL路径
   * @param gl WebGL渲染上下文
   * @param canvasWidth 画布宽度
   * @param canvasHeight 画布高度
   */
  async loadFromUrl(
    modelUrl: string,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    canvasWidth: number,
    canvasHeight: number,
  ): Promise<void> {
    this._gl = gl
    this._canvasWidth = canvasWidth
    this._canvasHeight = canvasHeight
    this._textureManager = new TextureManager(gl as WebGLRenderingContext)

    const lastSlash = modelUrl.lastIndexOf('/')
    this._modelHomeDir = lastSlash >= 0 ? modelUrl.substring(0, lastSlash + 1) : ''

    return new Promise<void>((resolve) => {
      this._loadResolve = resolve
      this.loadAssets(modelUrl)
    })
  }

  /**
   * 加载model3.json资源文件
   */
  private loadAssets(modelUrl: string): void {
    fetch(modelUrl)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => {
        const setting: ICubismModelSetting = new CubismModelSettingJson(
          arrayBuffer,
          arrayBuffer.byteLength,
        )
        this._modelSetting = setting
        this.setupModel(setting)
      })
      .catch((error) => {
        CubismLogError(`Failed to load model: ${modelUrl}`)
        // console.error(error)
        this._loadResolve?.()
        this._loadResolve = null
      })
  }

  /**
   * 根据model3.json设置加载所有模型资源
   */
  private setupModel(setting: ICubismModelSetting): void {
    this._updating = true
    this._initialized = false

    if (setting.getModelFileName() !== '') {
      const modelFileName = setting.getModelFileName()
      fetch(`${this._modelHomeDir}${modelFileName}`)
        .then((response) => {
          if (response.ok) return response.arrayBuffer()
          CubismLogError(`Failed to load moc3: ${this._modelHomeDir}${modelFileName}`)
          return null
        })
        .then((arrayBuffer) => {
          if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            CubismLogError(`Invalid moc3 data: ${this._modelHomeDir}${modelFileName}`)
            this._loadResolve?.()
            this._loadResolve = null
            return
          }
          this.loadModel(arrayBuffer)
          this.loadExpressionResources(setting)
        })
    }
  }

  /**
   * 加载表情文件
   */
  private loadExpressionResources(setting: ICubismModelSetting): void {
    const count = setting.getExpressionCount()
    if (count === 0) {
      this.loadPhysicsResource(setting)
      return
    }

    this._expressionCount = 0
    for (let i = 0; i < count; i++) {
      const expressionName = setting.getExpressionName(i)
      const expressionFileName = setting.getExpressionFileName(i)

      fetch(`${this._modelHomeDir}${expressionFileName}`)
        .then((response) => {
          if (response.ok) return response.arrayBuffer()
          CubismLogError(`Failed to load expression: ${expressionFileName}`)
          return new ArrayBuffer(0)
        })
        .then((arrayBuffer) => {
          const motion: ACubismMotion = this.loadExpression(
            arrayBuffer,
            arrayBuffer.byteLength,
            expressionName,
          )

          const existing = this._expressions.get(expressionName)
          if (existing != null) {
            ACubismMotion.delete(existing)
          }
          this._expressions.set(expressionName, motion)

          this._expressionCount++
          if (this._expressionCount >= count) {
            if (this._expressionManager != null) {
              const expressionUpdater = new CubismExpressionUpdater(this._expressionManager)
              this._updateScheduler.addUpdatableList(expressionUpdater)
            }
            this.loadPhysicsResource(setting)
          }
        })
    }
  }

  /**
   * 加载物理文件
   */
  private loadPhysicsResource(setting: ICubismModelSetting): void {
    const physicsFileName = setting.getPhysicsFileName()
    if (physicsFileName != null && physicsFileName !== '') {
      fetch(`${this._modelHomeDir}${physicsFileName}`)
        .then((response) => {
          if (response.ok) return response.arrayBuffer()
          return new ArrayBuffer(0)
        })
        .then((arrayBuffer) => {
          this.loadPhysics(arrayBuffer, arrayBuffer.byteLength)
          if (this._physics) {
            const physicsUpdater = new CubismPhysicsUpdater(this._physics)
            this._updateScheduler.addUpdatableList(physicsUpdater)
          }
          this.loadPoseResource(setting)
        })
    } else {
      this.loadPoseResource(setting)
    }
  }

  /**
   * 加载姿势文件
   */
  private loadPoseResource(setting: ICubismModelSetting): void {
    const poseFileName = setting.getPoseFileName()
    if (poseFileName != null && poseFileName !== '') {
      fetch(`${this._modelHomeDir}${poseFileName}`)
        .then((response) => {
          if (response.ok) return response.arrayBuffer()
          return new ArrayBuffer(0)
        })
        .then((arrayBuffer) => {
          this.loadPose(arrayBuffer, arrayBuffer.byteLength)
          if (this._pose) {
            const poseUpdater = new CubismPoseUpdater(this._pose)
            this._updateScheduler.addUpdatableList(poseUpdater)
          }
          // 继续加载动作资源
          this.setupEyeBlink(setting)
        })
    } else {
      // 没有姿势文件，直接初始化眨眼
      this.setupEyeBlink(setting)
    }
  }

  /**
   * 设置自动眨眼
   * @param enableAutoEyeBlink 是否启用自动眨眼，默认为 true
   */
  private setupEyeBlink(setting: ICubismModelSetting, enableAutoEyeBlink: boolean = true): void {
    if (enableAutoEyeBlink && setting.getEyeBlinkParameterCount() > 0) {
      this._eyeBlink = CubismEyeBlink.create(setting)
      const eyeBlinkUpdater = new CubismEyeBlinkUpdater(() => this._motionUpdated, this._eyeBlink)
      this._updateScheduler.addUpdatableList(eyeBlinkUpdater)
    }
    this.setupBreath()
  }

  /**
   * 禁用自动眨眼
   */
  disableEyeBlink(): void {
    if (this._eyeBlink) {
      // 从更新调度器中移除眨眼更新器
      const count = this._updateScheduler.getUpdatableCount()
      for (let i = 0; i < count; i++) {
        const updater = this._updateScheduler.getUpdatable(i)
        if (updater instanceof CubismEyeBlinkUpdater) {
          this._updateScheduler.removeUpdatableList(updater)
          break
        }
      }
      CubismEyeBlink.delete(this._eyeBlink)
      this._eyeBlink = null
    }
  }

  /**
   * 设置呼吸效果
   */
  private setupBreath(): void {
    this._breath = CubismBreath.create()
    const breathParameters: BreathParameterData[] = [
      // new BreathParameterData(this._idParamAngleX, 0.0, 15.0, 6.5345, 0.5),
      // new BreathParameterData(this._idParamAngleY, 0.0, 8.0, 3.5345, 0.5),
      // new BreathParameterData(this._idParamAngleZ, 0.0, 10.0, 5.5345, 0.5),
      // new BreathParameterData(this._idParamBodyAngleX, 0.0, 4.0, 15.5345, 0.5),
      // new BreathParameterData(
      //   CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamBreath),
      //   0.5,
      //   0.5,
      //   3.2345,
      //   1,
      // ),
    ]
    this._breath.setParameters(breathParameters)
    const breathUpdater = new CubismBreathUpdater(this._breath)
    this._updateScheduler.addUpdatableList(breathUpdater)
    this.setupLook()
  }

  /**
   * 设置视线追踪
   */
  private setupLook(): void {
    this._look = CubismLook.create()
    const lookParameters: LookParameterData[] = [
      new LookParameterData(this._idParamAngleX, 9.0, 0.0, 0.0),
      new LookParameterData(this._idParamAngleY, 0.0, 9.0, 0.0),
      new LookParameterData(this._idParamAngleZ, 0.0, 0.0, -4.5),
      new LookParameterData(this._idParamBodyAngleX, 1.5, 0.0, 0.0),
      new LookParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamEyeBallX),
        0.75,
        0.0,
        0.0,
      ),
      new LookParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamEyeBallY),
        0.0,
        0.75,
        0.0,
      ),
    ]
    this._look.setParameters(lookParameters)
    const lookUpdater = new CubismLookUpdater(this._look, this._dragManager)
    this._updateScheduler.addUpdatableList(lookUpdater)

    this._updateScheduler.sortUpdatableList()
    this.setupLayout()
  }

  /**
   * 设置模型布局
   * 在应用 model3.json 中的布局后，设置模型高度为画布高度的 50%
   */
  private setupLayout(): void {
    const layout: Map<string, number> = new Map()
    if (this._modelSetting == null || this._modelMatrix == null) return
    this._modelSetting.getLayoutMap(layout)
    this._modelMatrix.setupFromLayout(layout)

    // 设置模型高度为画布高度的 50%（保持宽高比）
    // 通过试验确定，0.94 的缩放能让模型占屏幕高度的约 50%
    this._modelMatrix.scale(0.94, 0.94)

    this.loadMotionResources()
  }

  /**
   * 加载所有动作文件
   */
  private loadMotionResources(): void {
    if (!this._modelSetting) return
    this._allMotionCount = 0
    this._motionCount = 0
    const group: string[] = []
    const motionGroupCount = this._modelSetting.getMotionGroupCount()

    for (let i = 0; i < motionGroupCount; i++) {
      group[i] = this._modelSetting.getMotionGroupName(i)
      this._allMotionCount += this._modelSetting.getMotionCount(group[i])
    }

    for (let i = 0; i < motionGroupCount; i++) {
      this.preLoadMotionGroup(group[i])
    }

    if (motionGroupCount === 0) {
      this.finalizeLoading()
    }
  }

  /**
   * 预加载指定动作组的所有动作
   */
  private preLoadMotionGroup(group: string): void {
    if (!this._modelSetting) return
    for (let i = 0; i < this._modelSetting.getMotionCount(group); i++) {
      const motionFileName = this._modelSetting.getMotionFileName(group, i)
      const name = `${group}_${i}`

      fetch(`${this._modelHomeDir}${motionFileName}`)
        .then((response) => {
          if (!response.ok) {
            CubismLogError(`Failed to load motion: ${motionFileName}`)
            return null
          }
          return response.arrayBuffer()
        })
        .then((arrayBuffer) => {
          // 如果加载失败，跳过这个动作
          if (arrayBuffer === null || arrayBuffer.byteLength === 0) {
            this._allMotionCount--
            if (this._motionCount >= this._allMotionCount) {
              this.finalizeLoading()
            }
            return
          }

          try {
            const tmpMotion: CubismMotion | null = this.loadMotion(
              arrayBuffer,
              arrayBuffer.byteLength,
              name,
              undefined,
              undefined,
              this._modelSetting!,
              group,
              i,
            )

            if (tmpMotion != null) {
              tmpMotion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds)
              const existing = this._motions.get(name)
              if (existing != null) {
                ACubismMotion.delete(existing)
              }
              this._motions.set(name, tmpMotion)
              this._motionCount++
            } else {
              this._allMotionCount--
            }
          } catch (e) {
            // console.warn(`[CubismModelWrapper] 加载动作失败: ${name}`, e)
            this._allMotionCount--
          }

          if (this._motionCount >= this._allMotionCount) {
            this.finalizeLoading()
          }
        })
        .catch((e) => {
          // console.warn(`[CubismModelWrapper] 获取动作文件失败: ${motionFileName}`, e)
          this._allMotionCount--
          if (this._motionCount >= this._allMotionCount) {
            this.finalizeLoading()
          }
        })
    }
  }

  /**
   * 完成加载，初始化渲染器并加载纹理
   */
  private finalizeLoading(): void {
    this._motionManager.stopAllMotions()
    this._updating = false
    this._initialized = true

    this.createRenderer(this._canvasWidth, this._canvasHeight)
    this.getRenderer().startUp(this._gl!)
    this.getRenderer().loadShaders(SHADER_PATH)
    this.setupTextures()
  }

  /**
   * 加载纹理
   */
  private setupTextures(): void {
    if (!this._modelSetting || !this._textureManager) return
    const usePremultiply = true
    const textureCount = this._modelSetting.getTextureCount()
    this._textureCount = 0

    if (textureCount === 0) {
      this.onLoadComplete()
      return
    }

    for (let modelTextureNumber = 0; modelTextureNumber < textureCount; modelTextureNumber++) {
      const textureFileName = this._modelSetting.getTextureFileName(modelTextureNumber)
      if (textureFileName === '') continue

      const texturePath = textureFileName.includes('/')
        ? this._modelHomeDir + textureFileName
        : this._modelHomeDir + (this._modelSetting.getTextureDirectory() || '') + textureFileName

      const currentTextureIndex = modelTextureNumber
      // console.log(`[TEXTURE LOAD] Index ${currentTextureIndex} -> ${textureFileName}`)
      const onLoad = (textureInfo: TextureInfo) => {
        if (textureInfo.id) {
          // console.log(`[TEXTURE BIND] Index ${currentTextureIndex} -> ${textureFileName} (${textureInfo.width}x${textureInfo.height})`)
          this.getRenderer().bindTexture(currentTextureIndex, textureInfo.id)
        } else {
          // console.error(`[TEXTURE ERROR] Failed to load: ${textureFileName}`)
        }
        this._textureCount++
        if (this._textureCount >= textureCount) {
          this.onLoadComplete()
        }
      }

      this._textureManager.createTextureFromPngFile(texturePath, usePremultiply, onLoad)
    }
    this.getRenderer().setIsPremultipliedAlpha(usePremultiply)
  }

  /** 加载完成处理 */
  private onLoadComplete(): void {
    this._loadComplete = true
    this.onLoaded?.()
    this._loadResolve?.()
    this._loadResolve = null
    // console.log('[CubismModelWrapper] Model loaded successfully')
    // this.debugWingDrawables()
  }

  /**
   * 调试翅膀相关的Drawable信息
   */
  private debugWingDrawables(): void {
    if (!this._model) return
    const drawableCount = this._model.getDrawableCount()
    const blendEnabled = this._model.isBlendModeEnabled()
    // console.log('[CubismModelWrapper] ===== 纹理渲染调试 =====')
    // console.log(`[CubismModelWrapper] isBlendModeEnabled=${blendEnabled}`)
    // console.log(`[CubismModelWrapper] totalDrawables=${drawableCount}`)

    const renderer = this.getRenderer() as any
    if (renderer.getModelRenderTarget) {
      try {
        const rt0 = renderer.getModelRenderTarget(0)
        const rt1 = renderer.getModelRenderTarget(1)
        // console.log(
        //   `[CubismModelWrapper] RenderTarget(0): ${rt0 ? 'exists' : 'NULL'}, size=${rt0?.getBufferWidth()}x${rt0?.getBufferHeight()}`,
        // )
        // console.log(
        //   `[CubismModelWrapper] RenderTarget(1): ${rt1 ? 'exists' : 'NULL'}, size=${rt1?.getBufferWidth()}x${rt1?.getBufferHeight()}`,
        // )
      } catch (e) {
        // console.log('[CubismModelWrapper] RenderTarget check error:', e)
      }
    }

    const tex0Drawables: number[] = []
    const tex1Drawables: number[] = []
    const tex2Drawables: number[] = []

    for (let i = 0; i < drawableCount; i++) {
      const textureIndex = this._model.getDrawableTextureIndex(i)
      if (this._model.getDrawableDynamicFlagIsVisible(i)) {
        if (textureIndex === 0) tex0Drawables.push(i)
        else if (textureIndex === 1) tex1Drawables.push(i)
        else if (textureIndex === 2) tex2Drawables.push(i)
      }
    }

    // console.log(
    //   `[CubismModelWrapper] Visible drawables: tex0=${tex0Drawables.length}, tex1=${tex1Drawables.length}, tex2=${tex2Drawables.length}`,
    // )

    // 详细输出texture_00的visible drawable（这是用户说的"贴图"层）
    // console.log('\n[CubismModelWrapper] ===== texture_00 (贴图层) 详情 =====')
    for (const i of tex0Drawables.slice(0, 15)) {
      const drawableId = this._model.getDrawableId(i)
      const idStr = drawableId?.getString?.() ?? ''
      const colorBlend = this._model.getDrawableColorBlend(i)
      const alphaBlend = this._model.getDrawableAlphaBlend(i)
      const opacity = this._model.getDrawableOpacity(i)
      const renderOrder = this._model.getRenderOrders()?.[i] ?? -1
      // console.log(
      //   `  [${i}] ${idStr}: order=${renderOrder}, colorBlend=${colorBlend}, alphaBlend=${alphaBlend}, opacity=${opacity.toFixed(3)}`,
      // )
    }
    // if (tex0Drawables.length > 15) console.log(`  ... 还有 ${tex0Drawables.length - 15} 个`)

    // 检查是否使用了高级混合模式
    // console.log('\n[CubismModelWrapper] ===== 高级混合模式检测 =====')
    let advancedBlendCount = 0
    for (const i of [...tex0Drawables, ...tex1Drawables]) {
      const colorBlend = this._model.getDrawableColorBlend(i)
      const alphaBlend = this._model.getDrawableAlphaBlend(i)
      // 当blend mode enabled时，非Normal+Over组合会走高级混合路径
      const isAdvanced =
        blendEnabled &&
        !((colorBlend === 0 && alphaBlend === 0) || (colorBlend === 0 && alphaBlend === 3))
      if (isAdvanced) {
        const drawableId = this._model.getDrawableId(i)
        const idStr = drawableId?.getString?.() ?? ''
        const texIdx = this._model.getDrawableTextureIndex(i)
        advancedBlendCount++
        if (advancedBlendCount <= 10) {
          // console.log(
          //   `  [${i}] ${idStr} (tex${texIdx}): colorBlend=${colorBlend}, alphaBlend=${alphaBlend} ★高级混合`,
          // )
        }
      }
    }
    // console.log(`[CubismModelWrapper] 总共 ${advancedBlendCount} 个drawable使用高级混合模式`)

    // 检查蒙版使用情况
    // console.log('\n[CubismModelWrapper] ===== 蒙版/Clip Mask 使用情况 =====')
    const masks = this._model.getDrawableMasks()
    const maskCounts = this._model.getDrawableMaskCounts()
    let maskUserCount = 0
    let maskSourceCount = 0
    const tex0MaskUsers: number[] = []
    const tex0MaskSources: number[] = []

    for (let i = 0; i < drawableCount; i++) {
      const maskCount = maskCounts[i]
      const textureIndex = this._model.getDrawableTextureIndex(i)

      // 这个drawable被哪些其他drawable作为蒙版
      if (maskCount > 0) {
        maskUserCount++
        if (textureIndex === 0) tex0MaskUsers.push(i)
      }

      // 这个drawable被用作蒙版（出现在其他drawable的mask列表中）
      let isUsedAsMask = false
      for (let j = 0; j < drawableCount; j++) {
        if (masks[j] && masks[j].includes(i)) {
          isUsedAsMask = true
          break
        }
      }
      if (isUsedAsMask) {
        maskSourceCount++
        if (textureIndex === 0) tex0MaskSources.push(i)
      }
    }

    // console.log(`[CubismModelWrapper] 使用蒙版的drawable: ${maskUserCount}个`)
    // console.log(`[CubismModelWrapper] 被用作蒙版的drawable: ${maskSourceCount}个`)
    // console.log(
    //   `[CubismModelWrapper] texture_00中作为蒙版源的drawable: ${tex0MaskSources.length}个`,
    // )

    if (tex0MaskSources.length > 0) {
      // console.log('\n[CubismModelWrapper] ===== texture_00 中被用作蒙版的drawable =====')
      for (const i of tex0MaskSources.slice(0, 10)) {
        const drawableId = this._model.getDrawableId(i)
        const idStr = drawableId?.getString?.() ?? ''
        // console.log(`  [${i}] ${idStr} - 这个drawable被用作蒙版!`)
      }
      // if (tex0MaskSources.length > 10) console.log(`  ... 还有 ${tex0MaskSources.length - 10} 个`)
    }

    if (tex0MaskUsers.length > 0) {
      // console.log('\n[CubismModelWrapper] ===== texture_00 中使用蒙版的drawable =====')
      for (const i of tex0MaskUsers.slice(0, 10)) {
        const drawableId = this._model.getDrawableId(i)
        const idStr = drawableId?.getString?.() ?? ''
        const maskList = masks[i]
        // console.log(`  [${i}] ${idStr} - 使用蒙版: [${Array.from(maskList).join(', ')}]`)
      }
      // if (tex0MaskUsers.length > 10) console.log(`  ... 还有 ${tex0MaskUsers.length - 10} 个`)
    }
  }

  /**
   * 更新模型
   * 每帧调用一次
   */
  update(): void {
    if (!this._loadComplete) return

    const deltaTimeSeconds = this.getDeltaTime()
    this._userTimeSeconds += deltaTimeSeconds

    this._model.loadParameters()
    this._motionUpdated = false

    if (this._motionManager.isFinished()) {
      this.startRandomMotion('Idle', PriorityIdle)
      // Idle 动作不抑制眨眼
      this._motionUpdated = false
    } else {
      const motionUpdated = this._motionManager.updateMotion(this._model, deltaTimeSeconds)
      // 仅在非 Idle 动作（Normal/Force）时抑制眨眼
      this._motionUpdated = motionUpdated && this._motionManager.getCurrentPriority() > PriorityIdle
    }
    this._model.saveParameters()

    // 应用外部参数输入值（在物理系统之前，作为物理系统的输入）
    this.applyExternalInputParameters()

    this._updateScheduler.onLateUpdate(this._model, deltaTimeSeconds)

    // 应用外部参数覆盖值（在物理系统之后，优先级最高）
    this.applyExternalParameters()

    this._model.update()
  }

  /**
   * 应用外部参数输入值（在物理系统之前）
   * 作为物理系统的输入
   */
  private applyExternalInputParameters(): void {
    if (!this._model || this._externalInputParams.size === 0) return
    for (const [paramId, value] of this._externalInputParams) {
      const id = CubismFramework.getIdManager().getId(paramId)
      this._model.setParameterValueById(id, value)
    }
  }

  /**
   * 应用外部参数覆盖值（在物理系统之后）
   * 优先级最高，覆盖物理系统的输出
   */
  private applyExternalParameters(): void {
    if (!this._model || this._externalParams.size === 0) return
    for (const [paramId, value] of this._externalParams) {
      const id = CubismFramework.getIdManager().getId(paramId)
      this._model.setParameterValueById(id, value)
    }
  }

  /**
   * 绘制模型
   * @param projection 投影矩阵
   */
  draw(projection: CubismMatrix44): void {
    if (!this._loadComplete || this._model == null) {
      // console.log('[DEBUG CubismModelWrapper.draw] Early return, loadComplete:', this._loadComplete, 'model:', !!this._model)
      return
    }

    // console.log('[DEBUG CubismModelWrapper.draw] Before multiplyByMatrix, projection:', projection?.getArray()?.slice(0, 4))
    projection.multiplyByMatrix(this._modelMatrix)
    // console.log('[DEBUG CubismModelWrapper.draw] After multiplyByMatrix, projection:', projection?.getArray()?.slice(0, 4))

    const renderer = this.getRenderer()
    renderer.setMvpMatrix(projection)
    // console.log('[DEBUG CubismModelWrapper.draw] After setMvpMatrix')

    const viewport = [0, 0, this._canvasWidth, this._canvasHeight]
    // null 表示绑定默认帧缓冲，SDK签名要求WebGLFramebuffer但null在WebGL中合法
    renderer.setRenderState(null as WebGLFramebuffer, viewport)
    // console.log('[DEBUG CubismModelWrapper.draw] After setRenderState')

    renderer.drawModel(SHADER_PATH)
    // console.log('[DEBUG CubismModelWrapper.draw] After drawModel')
    this._frameCount++
  }

  /**
   * 播放指定动作
   * @param group 动作组名
   * @param no 动作索引
   * @param priority 优先级
   * @param onFinishedMotionHandler 动作结束回调
   * @param onBeganMotionHandler 动作开始回调
   */
  startMotion(
    group: string,
    no: number,
    priority: number,
    onFinishedMotionHandler?: FinishedMotionCallback,
    onBeganMotionHandler?: BeganMotionCallback,
  ): CubismMotionQueueEntryHandle {
    if (!this._modelSetting) return InvalidMotionQueueEntryHandleValue

    if (priority === PriorityForce) {
      this._motionManager.setReservePriority(priority)
    } else if (!this._motionManager.reserveMotion(priority)) {
      return InvalidMotionQueueEntryHandleValue
    }

    const motionFileName = this._modelSetting.getMotionFileName(group, no)
    const name = `${group}_${no}`
    const cachedMotion: CubismMotion | null = (this._motions.get(name) as CubismMotion) ?? null

    if (cachedMotion != null) {
      if (onBeganMotionHandler) cachedMotion.setBeganMotionHandler(onBeganMotionHandler)
      if (onFinishedMotionHandler) cachedMotion.setFinishedMotionHandler(onFinishedMotionHandler)
      return this._motionManager.startMotionPriority(cachedMotion, false, priority)
    }

    this._motionManager.setReservePriority(PriorityNone)

    fetch(`${this._modelHomeDir}${motionFileName}`)
      .then((response) => {
        if (response.ok) return response.arrayBuffer()
        return new ArrayBuffer(0)
      })
      .then((arrayBuffer) => {
        if (arrayBuffer.byteLength === 0) return
        const motion = this.loadMotion(
          arrayBuffer,
          arrayBuffer.byteLength,
          name,
          onFinishedMotionHandler ?? undefined,
          onBeganMotionHandler ?? undefined,
          this._modelSetting!,
          group,
          no,
        )
        if (motion) {
          motion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds)
          const existing = this._motions.get(name)
          if (existing != null) {
            ACubismMotion.delete(existing)
          }
          this._motions.set(name, motion)
          if (this._motionManager.getCurrentPriority() < priority) {
            this._motionManager.startMotionPriority(motion, true, priority)
          }
        }
      })

    return InvalidMotionQueueEntryHandleValue
  }

  /**
   * 随机播放指定动作组的动作
   */
  startRandomMotion(
    group: string,
    priority: number,
    onFinishedMotionHandler?: FinishedMotionCallback,
    onBeganMotionHandler?: BeganMotionCallback,
  ): CubismMotionQueueEntryHandle {
    if (!this._modelSetting || this._modelSetting.getMotionCount(group) === 0) {
      return InvalidMotionQueueEntryHandleValue
    }
    const no = Math.floor(Math.random() * this._modelSetting.getMotionCount(group))
    return this.startMotion(group, no, priority, onFinishedMotionHandler, onBeganMotionHandler)
  }

  /**
   * 设置表情
   * @param expressionId 表情ID
   */
  setExpression(expressionId: string): void {
    const motion: ACubismMotion | undefined = this._expressions.get(expressionId)
    if (motion != null) {
      this._expressionManager.startMotion(motion, false)
    }
  }

  /**
   * 碰撞检测
   * @param hitAreaName 命中区域名称
   * @param x X坐标
   * @param y Y坐标
   */
  hitTest(hitAreaName: string, x: number, y: number): boolean {
    if (!this._modelSetting || this._opacity < 1) return false
    const count = this._modelSetting.getHitAreasCount()
    for (let i = 0; i < count; i++) {
      if (this._modelSetting.getHitAreaName(i) === hitAreaName) {
        const drawId: CubismIdHandle = this._modelSetting.getHitAreaId(i)
        return this.isHit(drawId, x, y)
      }
    }
    return false
  }

  /**
   * 检测任意命中区域是否被命中
   * @param x X坐标（相对于画布中心，已经过逆向变换）
   * @param y Y坐标（相对于画布中心，已经过逆向变换）
   */
  hitTestAny(x: number, y: number): boolean {
    if (!this._model || this._opacity < 1) return false

    return this.hitTestByBounds(x, y)
  }

  /**
   * 使用模型边界框进行命中检测
   * @param x X坐标（相对于画布中心，已经过逆向变换）
   * @param y Y坐标（相对于画布中心，已经过逆向变换）
   */
  private hitTestByBounds(x: number, y: number): boolean {
    if (!this._model) return false

    const tx = this._modelMatrix.invertTransformX(x)
    const ty = this._modelMatrix.invertTransformY(y)

    const modelW = this.canvasWidth
    const modelH = this.canvasHeight
    const scaleX = this._modelMatrix.getScaleX()
    const scaleY = this._modelMatrix.getScaleY()

    const actualWidth = modelW * scaleX
    const actualHeight = modelH * scaleY
    const aspectRatio = actualWidth / actualHeight

    const targetWidth = HIT_AREA_WIDTH_RATIO
    const targetHeight = HIT_AREA_HEIGHT_RATIO

    const halfWidth = (targetWidth / aspectRatio) * 0.5
    const halfHeight = targetHeight * 0.5

    const centerX = 0.5
    const centerY = 0.5

    const left = centerX - halfWidth
    const right = centerX + halfWidth
    const top = centerY - halfHeight
    const bottom = centerY + halfHeight

    return tx >= left && tx <= right && ty >= top && ty <= bottom
  }

  /** 停止所有动作 */
  stopAllMotions(): void {
    this._motionManager.stopAllMotions()
  }

  /**
   * 通过字符串ID设置参数值
   * 官方SDK的setParameterValueById需要CubismIdHandle，此方法提供字符串ID的便捷接口
   * @param paramId 参数字符串ID
   * @param value 参数值
   */
  setParameterValueByStringId(paramId: string, value: number): void {
    if (!this._model) return
    const id = CubismFramework.getIdManager().getId(paramId)
    this._model.setParameterValueById(id, value)
  }

  /**
   * 设置外部参数输入值
   * 在物理系统之前应用，作为物理系统的输入
   * 适用于 ParamBreath 等需要驱动物理效果的参数
   * @param paramId 参数字符串ID
   * @param value 参数值
   */
  setExternalInputParameter(paramId: string, value: number): void {
    this._externalInputParams.set(paramId, value)
  }

  /**
   * 清除外部参数输入值
   * @param paramId 参数字符串ID
   */
  clearExternalInputParameter(paramId: string): void {
    this._externalInputParams.delete(paramId)
  }

  /**
   * 设置外部参数覆盖值
   * 在物理系统之后应用，优先级高于动作/表情/物理等效果
   * 适用于视线追踪等需要覆盖物理效果的参数
   * 解决 loadParameters 每帧覆盖外部设置的问题
   * @param paramId 参数字符串ID
   * @param value 参数值
   */
  setExternalParameter(paramId: string, value: number): void {
    this._externalParams.set(paramId, value)
  }

  /**
   * 清除外部参数覆盖值
   * 清除后该参数将恢复为由动作/表情/物理等系统控制
   * @param paramId 参数字符串ID
   */
  clearExternalParameter(paramId: string): void {
    this._externalParams.delete(paramId)
  }

  /**
   * 通过字符串ID获取参数值
   * @param paramId 参数字符串ID
   */
  getParameterValueByStringId(paramId: string): number {
    if (!this._model) return 0
    const id = CubismFramework.getIdManager().getId(paramId)
    return this._model.getParameterValueById(id)
  }

  /** 设置拖拽位置 */
  setDragging(x: number, y: number): void {
    this._dragManager.set(x, y)
  }

  /** 更新画布尺寸 */
  updateCanvasSize(width: number, height: number): void {
    this._canvasWidth = width
    this._canvasHeight = height
    this.getRenderer().setRenderTargetSize(width, height)

    // 同时更新 WebGL 视口
    const gl = this._gl
    if (gl) {
      gl.viewport(0, 0, width, height)
    }
  }

  /** 获取帧间隔时间 */
  private getDeltaTime(): number {
    const currentTimeSeconds = performance.now() / 1000.0
    const deltaTimeSeconds = currentTimeSeconds - this._lastTimeSeconds
    this._lastTimeSeconds = currentTimeSeconds
    if (deltaTimeSeconds < 0.001) return 0.001
    return deltaTimeSeconds
  }

  /** 释放资源 */
  release(): void {
    if (this._look) {
      CubismLook.delete(this._look)
      this._look = null
    }
    if (this._updateScheduler) {
      this._updateScheduler.release()
    }
    if (this._textureManager) {
      this._textureManager.release()
      this._textureManager = null
    }
    this._motions.clear()
    this._expressions.clear()
    super.release()
  }
}
