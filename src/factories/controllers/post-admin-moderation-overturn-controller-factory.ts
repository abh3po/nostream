import { PostAdminModerationOverturnController } from '../../controllers/admin/post-admin-moderation-overturn-controller'
import { getMasterDbClient, getReadReplicaDbClient } from '../../database/client'
import { EventRepository } from '../../repositories/event-repository'
import { createSettings } from '../settings-factory'

export const createPostAdminModerationOverturnController = () => {
  const eventRepository = new EventRepository(getMasterDbClient(), getReadReplicaDbClient(), createSettings)
  return new PostAdminModerationOverturnController(eventRepository)
}
