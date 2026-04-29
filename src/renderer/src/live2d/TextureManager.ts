/**
 * 纹理信息结构体
 */
export class TextureInfo {
  /** HTMLImageElement */
  img!: HTMLImageElement
  /** WebGL纹理ID */
  id: WebGLTexture | null = null
  /** 纹理宽度 */
  width = 0
  /** 纹理高度 */
  height = 0
  /** 是否预乘Alpha */
  usePremultiply!: boolean
  /** 文件名 */
  fileName!: string
}

/**
 * 纹理管理类
 * 负责Live2D模型纹理的加载、缓存和释放
 */
export class TextureManager {
  private _textures: TextureInfo[] = []
  private _gl: WebGLRenderingContext

  constructor(gl: WebGLRenderingContext) {
    this._gl = gl
  }

  /**
   * 从PNG文件创建纹理
   * @param fileName 文件路径
   * @param usePremultiply 是否使用预乘Alpha
   * @param callback 加载完成回调
   */
  createTextureFromPngFile(
    fileName: string,
    usePremultiply: boolean,
    callback: (textureInfo: TextureInfo) => void,
  ): void {
    for (let i = 0; i < this._textures.length; i++) {
      if (
        this._textures[i].fileName === fileName &&
        this._textures[i].usePremultiply === usePremultiply
      ) {
        callback(this._textures[i])
        return
      }
    }

    const img = new Image()
    img.addEventListener(
      'load',
      () => {
        const gl = this._gl
        const tex: WebGLTexture | null = gl.createTexture()
        const textureInfo = new TextureInfo()
        if (!tex) {
          // console.error(`[TextureManager] 创建WebGL纹理失败: ${fileName}`)
          callback(textureInfo)
          return
        }

        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

        if (usePremultiply) {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)
        }

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.bindTexture(gl.TEXTURE_2D, null)

        textureInfo.fileName = fileName
        textureInfo.width = img.width
        textureInfo.height = img.height
        textureInfo.id = tex
        textureInfo.img = img
        textureInfo.usePremultiply = usePremultiply
        this._textures.push(textureInfo)

        callback(textureInfo)
      },
      { passive: true },
    )
    img.addEventListener(
      'error',
      (e) => {
        // console.error(`[TextureManager] 纹理加载失败: ${fileName}`, e)
        const textureInfo = new TextureInfo()
        textureInfo.fileName = fileName
        callback(textureInfo)
      },
      { passive: true },
    )
    img.src = fileName
  }

  /** 释放所有纹理 */
  release(): void {
    for (let i = 0; i < this._textures.length; i++) {
      if (this._textures[i].id) {
        this._gl.deleteTexture(this._textures[i].id)
      }
    }
    this._textures = []
  }
}
