import EventEmitter from 'events'
import chai from 'chai'
import sinonChai from 'sinon-chai'
import Sinon from 'sinon'

chai.use(sinonChai)

import { Event } from '../../../src/@types/event'
import { IncomingEventMessage, MessageType } from '../../../src/@types/messages'
import { ModerationQuarantineMetadataKey } from '../../../src/constants/base'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'
import { EventMessageHandler } from '../../../src/handlers/event-message-handler'
import { ModerationDecision } from '../../../src/services/moderation-service'

const { expect } = chai

const makeEvent = (overrides: Partial<Event> = {}): Event =>
  ({
    id: 'f'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    sig: 'f'.repeat(128),
    content: 'hello world',
    ...overrides,
  }) as Event

const buildHandler = (sandbox: Sinon.SinonSandbox, decision: ModerationDecision | undefined) => {
  const webSocket = new EventEmitter() as any
  const onMessage = sandbox.fake()
  webSocket.on(WebSocketAdapterEvent.Message, onMessage)

  const strategyFactory = sandbox.stub()
  const strategyExecute = sandbox.stub().resolves(undefined)
  strategyFactory.returns({ execute: strategyExecute })

  const moderationService = {
    evaluate: sandbox.stub().returns(decision),
    recordReport: sandbox.fake(),
  }

  const handler = new EventMessageHandler(
    webSocket as any,
    strategyFactory as any,
    {} as any,
    { isVanished: sandbox.stub().resolves(false) } as any,
    () => ({ info: { relay_url: 'relay_url' } }) as any,
    {} as any,
    { hasKey: async () => false, setKey: async () => true } as any,
    () => ({ hit: async () => false }),
    moderationService as any,
  )

  return { handler, webSocket, onMessage, strategyFactory, strategyExecute, moderationService }
}

describe('EventMessageHandler moderation', () => {
  let sandbox: Sinon.SinonSandbox
  let origEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    origEnv = { ...process.env }
    process.env = { SECRET: 'changeme' }
    // Bypass the pre-moderation gates that need more setup.
    sandbox.stub(EventMessageHandler.prototype, 'isEventValid' as any).resolves(undefined)
    sandbox.stub(EventMessageHandler.prototype, 'isRateLimited' as any).resolves(false)
    sandbox.stub(EventMessageHandler.prototype, 'canAcceptEvent' as any).returns(undefined)
    sandbox.stub(EventMessageHandler.prototype, 'isBlockedByRequestToVanish' as any).resolves(undefined)
    sandbox.stub(EventMessageHandler.prototype, 'isUserAdmitted' as any).resolves(undefined)
    sandbox.stub(EventMessageHandler.prototype, 'checkNip05Verification' as any).resolves(undefined)
  })

  afterEach(() => {
    process.env = origEnv
    sandbox.restore()
  })

  it('rejects with an explicit reason when the rule action is reject', async () => {
    const { handler, onMessage, strategyExecute } = buildHandler(sandbox, { action: 'reject', rule: 'link_flood' })
    const event = makeEvent()
    const message: IncomingEventMessage = [MessageType.EVENT, event]

    await handler.handleMessage(message)

    expect(strategyExecute).to.not.have.been.called
    expect(onMessage).to.have.been.calledWithExactly([MessageType.OK, event.id, false, 'blocked: event flagged by moderation'])
  })

  it('stores a quarantined event without a reason and tags it', async () => {
    const { handler, onMessage, strategyFactory, strategyExecute } = buildHandler(sandbox, {
      action: 'quarantine',
      rule: 'duplicate_burst',
    })
    const event = makeEvent()
    const message: IncomingEventMessage = [MessageType.EVENT, event]

    await handler.handleMessage(message)

    expect(strategyFactory).to.have.been.called
    const forwarded = strategyFactory.firstCall.args[0][0] as Event & { [ModerationQuarantineMetadataKey]?: string }
    expect(forwarded[ModerationQuarantineMetadataKey]).to.equal('duplicate_burst')
    expect(strategyExecute).to.have.been.called
    // No rejection OK; the strategy emits the success OK itself.
    expect(onMessage).to.not.have.been.calledWith([MessageType.OK, event.id, false, 'blocked: event flagged by moderation'])
  })

  it('passes a clean event through untouched', async () => {
    const { handler, strategyFactory } = buildHandler(sandbox, undefined)
    const event = makeEvent()
    const message: IncomingEventMessage = [MessageType.EVENT, event]

    await handler.handleMessage(message)

    const forwarded = strategyFactory.firstCall.args[0][0] as Event & { [ModerationQuarantineMetadataKey]?: string }
    expect(forwarded[ModerationQuarantineMetadataKey]).to.equal(undefined)
  })
})
