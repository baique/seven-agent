const DENY_LIST = ['rm -rf /', 'rm -rf /*']

export function isSafe(command: string): boolean {
  const lower = command.toLowerCase().trim()

  for (const pattern of DENY_LIST) {
    if (lower.includes(pattern.toLowerCase())) {
      return false
    }
  }

  return true
}

export function validateCommand(command: string): void {
  if (!command || command.trim().length === 0) {
    throw new Error('Command cannot be empty')
  }

  if (!isSafe(command)) {
    throw new Error(`Command "${command}" is not allowed`)
  }
}
