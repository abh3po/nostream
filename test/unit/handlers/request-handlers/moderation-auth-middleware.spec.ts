import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'
import axios from 'axios'

import { Tag } from '../../../../src/@types/base'
import { EventKinds, EventTags } from '../../../../src/constants/base'
import * as settingsFactory from '../../../../src/factories/settings-factory'
import {
  clearModerationAdminCache,
  moderationAuthMiddleware,
} from '../../../../src/handlers/request-handlers/moderation-auth-middleware'
import { AdminRequest } from '../../../../src/handlers/request-handlers/admin-json-body-middleware'
import { getPublicKey, identifyEvent, signEvent, toNostrEvent } from '../../../../src/utils/event'
import { DBEvent } from '../../../../src/@types/event'

chai.use(sinonChai)
const { expect } = chai

describe('moderationAuthMiddleware', () => {
  const privkey = 'a'.repeat(64)
  const pubkey = getPublicKey(privkey)
  const now = 1_700_000_000
  const base = 'https://relay.example.com'
  const path = '/moderation/queue'
  const url = `${base}${path}`

  let sandbox: Sinon.SinonSandbox
  let next: Sinon.SinonStub
  let response: { status: Sinon.SinonStub; setHeader: Sinon.SinonStub; send: Sinon.SinonStub }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    clearModerationAdminCache()
    next = sandbox.stub()
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
  })

  afterEach(() => {
    sandbox.restore()
    clearModerationAdminCache()
  })

  const enableModeration = (membersApiUrl = 'http://db:4000') => {
    sandbox.stub(settingsFactory, 'createSettings').returns({
      info: { relay_url: 'wss://relay.example.com' },
      network: {},
      moderation: { enabled: true, membersApiUrl },
    } as any)
  }

  const mockRequest = (overrides: Partial<AdminRequest> = {}): AdminRequest =>
    ({
      method: 'GET',
      originalUrl: path,
      headers: {},
      get: (name: string) => (name.toLowerCase() === 'host' ? 'relay.example.com' : undefined),
      socket: { remoteAddress: '127.0.0.1' },
      ...overrides,
    }) as any

  const createAuthHeader = async (target = url) => {
    const tags: Tag[] = [
      [EventTags.Url, target],
      [EventTags.Method, 'GET'],
    ]
    const identified = await identifyEvent({
      pubkey,
      created_at: now,
      kind: EventKinds.HTTP_AUTH,
      tags,
      content: '',
    })
    const signed = await signEvent(privkey)(identified)
    return `Nostr ${Buffer.from(JSON.stringify(signed), 'utf8').toString('base64')}`
  }

  it('returns 404 when moderation is disabled', async () => {
    sandbox.stub(settingsFactory, 'createSettings').returns({ info: { relay_url: 'wss://relay.example.com' }, network: {} } as any)
    await moderationAuthMiddleware(mockRequest(), response as any, next)
    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(404)
  })

  it('rejects a missing Authorization header', async () => {
    enableModeration()
    await moderationAuthMiddleware(mockRequest(), response as any, next)
    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })

  it('allows an active admin', async () => {
    enableModeration()
    sandbox.stub(Date, 'now').returns(now * 1000)
    const get = sandbox.stub(axios, 'get').resolves({ status: 200, data: { role: 'ADMIN', status: 'ACTIVE' } })
    const request = mockRequest({ headers: { authorization: await createAuthHeader() } })

    await moderationAuthMiddleware(request, response as any, next)

    expect(get).to.have.been.calledOnce
    // db-api keys the roster by npub, not hex — the lookup must use npub.
    const url = get.firstCall.args[0] as string
    expect(url).to.match(/\/members\/npub1[0-9a-z]+$/)
    expect(next).to.have.been.calledOnce
    expect(request.nip98Pubkey).to.equal(pubkey)
  })

  it('rejects a valid signature from a non-admin', async () => {
    enableModeration()
    sandbox.stub(Date, 'now').returns(now * 1000)
    sandbox.stub(axios, 'get').resolves({ status: 200, data: { role: 'CLIENT', status: 'ACTIVE' } })

    await moderationAuthMiddleware(mockRequest({ headers: { authorization: await createAuthHeader() } }), response as any, next)

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })

  it('fails closed when db-api is unreachable', async () => {
    enableModeration()
    sandbox.stub(Date, 'now').returns(now * 1000)
    sandbox.stub(axios, 'get').rejects(new Error('ECONNREFUSED'))

    await moderationAuthMiddleware(mockRequest({ headers: { authorization: await createAuthHeader() } }), response as any, next)

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })

  it('rejects a signature bound to a different URL', async () => {
    enableModeration()
    sandbox.stub(Date, 'now').returns(now * 1000)
    const get = sandbox.stub(axios, 'get').resolves({ status: 200, data: { role: 'ADMIN', status: 'ACTIVE' } })

    await moderationAuthMiddleware(
      mockRequest({ headers: { authorization: await createAuthHeader(`${base}/moderation/other`) } }),
      response as any,
      next,
    )

    expect(get).not.to.have.been.called
    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })
})

describe('serializeModeratedEvent', () => {
  const now = 1_700_000_000

  it('encodes binary columns and exposes moderation metadata', async () => {
    const { serializeModeratedEvent } = await import('../../../../src/utils/moderation-serialization')
    const id = '1'.repeat(64)
    const pubkey = 'a'.repeat(64)
    const row = {
      id: 'x',
      event_id: Buffer.from(id, 'hex'),
      event_pubkey: Buffer.from(pubkey, 'hex'),
      event_kind: 1,
      event_created_at: now,
      event_content: 'spammy',
      event_tags: [['t', 'x']],
      event_signature: Buffer.alloc(64, 1),
      first_seen: new Date(),
      quarantined_at: new Date(now * 1000),
      moderation_reason: 'link_flood',
      moderation_reviewed_by: Buffer.from(pubkey, 'hex'),
    } as unknown as DBEvent

    const result = serializeModeratedEvent(row)
    expect(result.id).to.equal(id)
    expect(result.pubkey).to.equal(pubkey)
    expect(result.reason).to.equal('link_flood')
    expect(result.reviewedBy).to.equal(pubkey)
    expect(result.quarantinedAt).to.be.a('string')
    // Round-trips through the Nostr event shape the UI expects.
    expect(toNostrEvent(row).id).to.equal(id)
  })
})
