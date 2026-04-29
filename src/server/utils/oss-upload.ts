import { logger } from './logger'

export async function uploadFileAndGetUrl(fileBuffer: Buffer, fileName: string): Promise<string> {
  try {
    logger.info(`[0x0.st Upload] Uploading file: ${fileName}`)

    const formData = new FormData()
    const blob = new Blob([new Uint8Array(fileBuffer)])
    formData.append('file', blob, fileName)

    const response = await fetch('https://0x0.st', {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Upload failed: ${errorText}`)
    }

    const url = (await response.text()).trim()
    logger.info(`[0x0.st Upload] Upload successful: ${url}`)

    return url
  } catch (error: any) {
    logger.error(`[0x0.st Upload] Upload failed: ${error.message}`)
    throw error
  }
}
