import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IEventRepository } from '../../@types/repositories'
import { createLogger } from '../../factories/logger-factory'
import { serializeModeratedEvent } from '../../utils/moderation-serialization'

const logger = createLogger('get-admin-moderation-queue-controller')
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Lists quarantined events awaiting review. Admin-authenticated upstream
 * (adminAuthMiddleware); this controller only reads.
 */
export class GetAdminModerationQueueController implements IController {
  public constructor(private readonly eventRepository: IEventRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const rawLimit = Number(request.query.limit)
    const rawOffset = Number(request.query.offset)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

    try {
      const [rows, total] = await Promise.all([
        this.eventRepository.listQuarantined({ limit, offset }),
        this.eventRepository.countQuarantined(),
      ])

      response.status(200).setHeader('content-type', 'application/json; charset=utf8').send({
        total,
        limit,
        offset,
        events: rows.map((row) => serializeModeratedEvent(row)),
      })
    } catch (error) {
      logger.error('unable to list quarantined events: %o', error)
      response.status(500).setHeader('content-type', 'application/json; charset=utf8').send({ error: 'internal_error' })
    }
  }
}
