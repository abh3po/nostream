import { Event } from '../../@types/event'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'
import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'

const logger = createLogger('quarantine-event-strategy')

/**
 * Persists a moderation-flagged event into quarantine.
 *
 * The event is stored so an operator can review and overturn it within the
 * window, but it is deliberately never broadcast: the relay answers `OK true`
 * (indistinguishable from a normal accept) and the repository hides the row
 * from every read path. This is the "shadow" behaviour described in
 * MODERATION.md.
 */
export class QuarantineEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly reason: string,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('quarantining event %s: %s', event.id, this.reason)

    const count = await this.eventRepository.createQuarantined(event, this.reason)

    // Shadow response: reported as accepted, identical to a clean publish.
    this.webSocket.emit(WebSocketAdapterEvent.Message, createEventCommandResult(event.id, true, count ? '' : 'duplicate:'))

    // No WebSocketAdapterEvent.Broadcast on purpose.
  }
}
