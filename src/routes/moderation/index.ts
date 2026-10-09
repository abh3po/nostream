import express, { Router } from 'express'

import { createGetAdminModerationQueueController } from '../../factories/controllers/get-admin-moderation-queue-controller-factory'
import { createPostAdminModerationDeleteController } from '../../factories/controllers/post-admin-moderation-delete-controller-factory'
import { createPostAdminModerationOverturnController } from '../../factories/controllers/post-admin-moderation-overturn-controller-factory'
import { moderationAuthMiddleware } from '../../handlers/request-handlers/moderation-auth-middleware'
import { rateLimiterMiddleware } from '../../handlers/request-handlers/rate-limiter-middleware'
import { withAdminController } from '../../handlers/request-handlers/with-admin-controller-request-handler'

/**
 * Relay moderation API.
 *
 * Deliberately separate from the `/admin` router: that router is gated by
 * `admin.enabled` (the password-login admin console), whereas moderation is
 * authenticated per-request with NIP-98 and an active-admin check against the
 * roster. The two features must be independently enableable.
 */
const router: Router = Router()

router.use(rateLimiterMiddleware)

router.get(
  '/queue',
  moderationAuthMiddleware,
  withAdminController(createGetAdminModerationQueueController),
)

router.post(
  '/:eventId/overturn',
  moderationAuthMiddleware,
  withAdminController(createPostAdminModerationOverturnController),
)

router.post(
  '/:eventId/delete',
  moderationAuthMiddleware,
  withAdminController(createPostAdminModerationDeleteController),
)

export default router
