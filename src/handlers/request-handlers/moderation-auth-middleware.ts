import axios from 'axios'
import { NextFunction, Response } from 'express'

import { AdminRequest } from './admin-json-body-middleware'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getAbsoluteHttpRequestUrl } from '../../utils/http'
import {
  DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH,
  isNostrAuthorizationHeader,
  verifyNip98Auth,
} from '../../utils/nip98'
import { toBech32 } from '../../utils/transform'
import { Settings } from '../../@types/settings'

const logger = createLogger('moderation-auth-middleware')

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const HEX_64 = /^[0-9a-f]{64}$/
const ADMIN_CHECK_TIMEOUT_MS = 5000
const ADMIN_CHECK_CACHE_SECONDS = 60

type CacheEntry = { isAdmin: boolean; expiresAt: number }
const adminCache = new Map<string, CacheEntry>()

const DEFAULT_MEMBERS_API_URL = 'http://db:4000'

const membersApiUrl = (settings: Settings): string | undefined => {
  const configured = settings.moderation?.membersApiUrl ?? process.env.MODERATION_MEMBERS_API_URL
  const url = (configured ?? DEFAULT_MEMBERS_API_URL).trim()
  return url.length ? url.replace(/\/+$/, '') : undefined
}

/**
 * Confirm the caller is an *active admin* by reading the Member table over the
 * internal db-api. This is the standalone-moderation-service identity model:
 * nostream does not link the control plane, it only asks the same data layer
 * that owns the roster. Fail closed on any error.
 *
 * Results are cached briefly per worker to keep a hot review UI from hammering
 * db-api; revocation therefore takes effect within {@link ADMIN_CHECK_CACHE_SECONDS}.
 */
const isActiveAdmin = async (settings: Settings, pubkey: string): Promise<boolean> => {
  const normalized = pubkey.toLowerCase()
  const cached = adminCache.get(normalized)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached.isAdmin
  }

  const baseUrl = membersApiUrl(settings)
  if (!baseUrl) {
    logger('moderation auth: no members API URL configured; denying')
    return false
  }

  // db-api keys the Member roster by npub, while NIP-98 hands us a hex pubkey.
  let npub: string
  try {
    npub = toBech32('npub')(normalized)
  } catch {
    logger('moderation auth: could not encode pubkey %s as npub', normalized)
    return false
  }

  try {
    const response = await axios.get(`${baseUrl}/members/${encodeURIComponent(npub)}`, {
      timeout: ADMIN_CHECK_TIMEOUT_MS,
      validateStatus: () => true,
      headers: { accept: 'application/json' },
    })

    const member = response.data as { role?: unknown; status?: unknown } | undefined
    const isAdmin = response.status === 200 && member?.role === 'ADMIN' && member?.status === 'ACTIVE'
    adminCache.set(normalized, { isAdmin, expiresAt: now + ADMIN_CHECK_CACHE_SECONDS * 1000 })
    return isAdmin
  } catch (error) {
    logger('moderation auth: members API check failed for %s: %o', npub, error)
    // Do not cache a failure: a transient db-api outage should not lock an
    // admin out for the whole cache window.
    if (cached) {
      return cached.isAdmin
    }
    return false
  }
}

const unauthorized = (response: Response): void => {
  response.status(401).setHeader('content-type', 'application/json').send({ error: 'Unauthorized' })
}

const resolveBody = (request: AdminRequest): Buffer | undefined =>
  METHODS_WITH_BODY.has(request.method.toUpperCase()) ? request.rawBody ?? Buffer.alloc(0) : undefined

/**
 * Gate for moderation routes. Verifies the NIP-98 `Authorization: Nostr` header
 * against the exact request URL/method/body, then requires the signer to be an
 * active admin per db-api. No password session and no `admin.enabled` coupling.
 */
export const moderationAuthMiddleware = async (request: AdminRequest, response: Response, next: NextFunction) => {
  try {
    const settings = createSettings()
    const moderation = settings.moderation

    if (!moderation?.enabled) {
      response.status(404).setHeader('content-type', 'application/json').send({ error: 'Not Found' })
      return
    }

    const authorizationHeader = request.headers.authorization
    if (!isNostrAuthorizationHeader(authorizationHeader)) {
      unauthorized(response)
      return
    }

    if (authorizationHeader.length > DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH) {
      logger('rejecting moderation auth: header too large')
      unauthorized(response)
      return
    }

    const absoluteUrl = getAbsoluteHttpRequestUrl(request, settings)
    if (!absoluteUrl) {
      logger('rejecting moderation auth: unable to build absolute request URL')
      unauthorized(response)
      return
    }

    const result = await verifyNip98Auth({
      authorizationHeader,
      url: absoluteUrl,
      method: request.method.toUpperCase(),
      body: resolveBody(request),
      payloadPolicy: 'require-when-body',
    })

    if (result.ok === false) {
      logger('rejecting moderation auth: %s', result.reason)
      unauthorized(response)
      return
    }

    if (!HEX_64.test(result.pubkey) || !(await isActiveAdmin(settings, result.pubkey))) {
      logger('rejecting moderation auth: %s is not an active admin', result.pubkey)
      unauthorized(response)
      return
    }

    request.nip98Pubkey = result.pubkey
    next()
  } catch (error) {
    logger('moderation auth error: %o', error)
    response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
  }
}

/** Test-only: clear the short-lived admin check cache. */
export const clearModerationAdminCache = (): void => {
  adminCache.clear()
}
