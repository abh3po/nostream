import { PostAdminModerationDeleteController } from '../../controllers/admin/post-admin-moderation-delete-controller'
import { getMasterDbClient, getReadReplicaDbClient } from '../../database/client'
import { EventRepository } from '../../repositories/event-repository'
import { createSettings } from '../settings-factory'

export const createPostAdminModerationDeleteController = () => {
  const eventRepository = new EventRepository(getMasterDbClient(), getReadReplicaDbClient(), createSettings)
  return new PostAdminModerationDeleteController(eventRepository)
}
