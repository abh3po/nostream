import { ModerationService } from '../services/moderation-service'
import { createSettings } from './settings-factory'

/**
 * Per-worker singleton. The duplicate-burst and report-quorum windows are
 * in-memory and must be shared across every event handler in a worker, so the
 * service is created once per process rather than per message.
 */
let moderationService: ModerationService | undefined

export const createModerationService = (): ModerationService => {
  if (!moderationService) {
    moderationService = new ModerationService(createSettings)
  }
  return moderationService
}
