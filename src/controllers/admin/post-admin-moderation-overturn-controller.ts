import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IEventRepository } from '../../@types/repositories'
import { serializeModeratedEvent } from '../../utils/moderation-serialization'
import { createLogger } from '../../factories/logger-factory'
import { AdminRequest } from '../../handlers/request-handlers/admin-json-body-middleware'

const logger = createLogger('post-admin-moderation-overturn-controller')

const HEX_64 = /^[0-9a-f]{64}$/

/** Overturn (restore) a quarantined event so it is published again. */
export class PostAdminModerationOverturnController implements IController {
  public constructor(private readonly eventRepository: IEventRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const eventId = request.params.eventId
    if (typeof eventId !== 'string' || !HEX_64.test(eventId)) {
      response.status(400).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'invalid_event_id' })
      return
    }

    const reviewer = (request as AdminRequest).nip98Pubkey
    if (typeof reviewer !== 'string' || !HEX_64.test(reviewer)) {
      response.status(401).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'Unauthorized' })
      return
    }

    try {
      // The mesh-PG gateway reports 0 affected rows for broad writes, so the
      // UPDATE's rowCount cannot be used to detect existence. Confirm by
      // reading the row after the update instead.
      const before = await this.eventRepository.findQuarantined(eventId)
      if (!before) {
        response.status(404).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'not_found' })
        return
      }

      await this.eventRepository.overturnQuarantine(eventId, reviewer)

      const row = await this.eventRepository.findQuarantined(eventId)
      response
        .status(200)
        .setHeader('content-type', 'application/json; charset=utf8')
        .send({ overturned: true, event: row ? serializeModeratedEvent(row) : null })
    } catch (error) {
      logger.error('unable to overturn quarantine for %s: %o', eventId, error)
      response.status(500).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'internal_error' })
    }
  }
}
