import type {
  AudioCommand,
  CharacterCommand,
  PauseCommand,
  StateCommand,
} from './useCharacterAction'
import { StateCommandFromBackend } from '../state/characterStates'

export interface TimelineSegment {
  audio: AudioCommand | null
  duration: number
  faces: StateCommandFromBackend[]
  acts: StateCommandFromBackend[]
  emotions: StateCommandFromBackend[]
}

function parseAndExpand(commands: StateCommandFromBackend[]): StateCommandFromBackend[] {
  const result: StateCommandFromBackend[] = []
  for (const cmd of commands) {
    const ids = cmd.id
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const singleId of ids) {
      result.push({ ...cmd, id: singleId })
    }
  }
  return result
}

export function buildSegments(commands: CharacterCommand[]): TimelineSegment[] {
  const segments: TimelineSegment[] = []
  let currentSegment: TimelineSegment | null = null

  for (const cmd of commands) {
    if (cmd.type === 'audio') {
      currentSegment = {
        audio: cmd,
        duration: cmd.duration || 1000,
        faces: [],
        acts: [],
        emotions: [],
      }
      segments.push(currentSegment)
    } else if (cmd.type === 'pause') {
      currentSegment = {
        audio: null,
        duration: (cmd as PauseCommand).duration * 1000,
        faces: [],
        acts: [],
        emotions: [],
      }
      segments.push(currentSegment)
    } else if (currentSegment) {
      const stateCmd = cmd as StateCommand
      if (stateCmd.type === 1) {
        const ids = stateCmd.id
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        for (const singleId of ids) {
          currentSegment.faces.push({ type: 1, id: singleId, intensity: stateCmd.intensity })
        }
      } else if (stateCmd.type === 2) {
        currentSegment.acts.push({ type: 2, id: stateCmd.id, intensity: stateCmd.intensity })
      } else if (stateCmd.type === 3) {
        currentSegment.emotions.push({ type: 3, id: stateCmd.id, intensity: stateCmd.intensity })
      }
    } else {
      currentSegment = {
        audio: null,
        duration: 0,
        faces: [],
        acts: [],
        emotions: [],
      }
      const stateCmd = cmd as StateCommand
      if (stateCmd.type === 1) {
        const ids = stateCmd.id
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        for (const singleId of ids) {
          currentSegment.faces.push({ type: 1, id: singleId, intensity: stateCmd.intensity })
        }
      } else if (stateCmd.type === 2) {
        currentSegment.acts.push({ type: 2, id: stateCmd.id, intensity: stateCmd.intensity })
      } else if (stateCmd.type === 3) {
        currentSegment.emotions.push({ type: 3, id: stateCmd.id, intensity: stateCmd.intensity })
      }
      segments.push(currentSegment)
    }
  }

  for (const seg of segments) {
    if (seg.audio?.timeline) {
      for (const item of seg.audio.timeline) {
        if (item.type === 1) {
          const expanded = parseAndExpand([item])
          seg.faces.push(...expanded)
        } else if (item.type === 2) {
          seg.acts.push(item)
        } else if (item.type === 3) {
          seg.emotions.push(item)
        }
      }
    }
  }

  return segments
}
