import { GetAdminModerationQueueController } from '../../controllers/admin/get-admin-moderation-queue-controller'
import { getMasterDbClient, getReadReplicaDbClient } from '../../database/client'
import { EventRepository } from '../../repositories/event-repository'
import { createSettings } from '../settings-factory'

export const createGetAdminModerationQueueController = () => {
  const eventRepository = new EventRepository(getMasterDbClient(), getReadReplicaDbClient(), createSettings)
  return new GetAdminModerationQueueController(eventRepository)
}
