import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IEventRepository } from '../../@types/repositories'
import { createLogger } from '../../factories/logger-factory'

const logger = createLogger('post-admin-moderation-delete-controller')

const HEX_64 = /^[0-9a-f]{64}$/

/** Permanently delete a quarantined event now, without waiting for the window. */
export class PostAdminModerationDeleteController implements IController {
  public constructor(private readonly eventRepository: IEventRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const eventId = request.params.eventId
    if (typeof eventId !== 'string' || !HEX_64.test(eventId)) {
      response.status(400).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'invalid_event_id' })
      return
    }

    try {
      // mesh-PG reports 0 rows for broad writes, so confirm existence by read
      // before deleting rather than trusting the DELETE's rowCount.
      const before = await this.eventRepository.findQuarantined(eventId)
      if (!before) {
        response.status(404).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'not_found' })
        return
      }

      await this.eventRepository.deleteQuarantined(eventId)

      response.status(200).setHeader('content-type', 'application/json; charset=utf8').send({ deleted: true })
    } catch (error) {
      logger.error('unable to delete quarantined event %s: %o', eventId, error)
      response.status(500).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'internal_error' })
    }
  }
}
