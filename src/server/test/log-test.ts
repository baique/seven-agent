import '../config/env'
import { messageProcessor } from '../core/graph'
import { generateSessionNotes } from '../core/summary'
import { GLOBAL_MEMORY } from '../memory'
import { convertToMessages, logger } from '../utils'
import { convertMemoryMessageToBaseMessages } from '../utils/message-utils'

const test = async () => {
  logger.info('测试INFO日志')
  logger.debug('测试DEBUG日志')
  logger.error('测试ERROR日志')
}

test()
