import { logger } from '../../utils/logger'

export { readFileTool } from './filesystem/read-file'
export { readLineTool } from './filesystem/read-line'
export { writeFileTool } from './filesystem/write-file'
export { editFileTool } from './filesystem/edit-file'
export { grepTool } from './filesystem/grep'
export { listDirectoryTool } from './filesystem/list-directory'
export { deleteFileTool } from './filesystem/delete-file'
export { createDirectoryTool } from './filesystem/create-directory'
export { moveFileTool } from './filesystem/move-file'
export { copyFileTool } from './filesystem/copy-file'
export { getFileInfoTool } from './filesystem/get-file-info'
export { fileExistsTool } from './filesystem/file-exists'

import {
  readFileTool,
  readLineTool,
  writeFileTool,
  editFileTool,
  grepTool,
  listDirectoryTool,
  deleteFileTool,
  createDirectoryTool,
  moveFileTool,
  copyFileTool,
  getFileInfoTool,
  fileExistsTool,
} from './filesystem/index'

export const fileSystemTools = [
  readFileTool,
  readLineTool,
  writeFileTool,
  editFileTool,
  grepTool,
  listDirectoryTool,
  deleteFileTool,
  createDirectoryTool,
  moveFileTool,
  copyFileTool,
  getFileInfoTool,
  fileExistsTool,
]

logger.info('[fileSystemTools] 工具体系已迁移到 filesystem/ 目录')
