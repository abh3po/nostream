import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)

import { eventStrategyFactory } from '../../../src/factories/event-strategy-factory'
import { Event } from '../../../src/@types/event'
import { ModerationQuarantineMetadataKey } from '../../../src/constants/base'
import { QuarantineEventStrategy } from '../../../src/handlers/event-strategies/quarantine-event-strategy'
import { DefaultEventStrategy } from '../../../src/handlers/event-strategies/default-event-strategy'

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

describe('eventStrategyFactory moderation', () => {
  it('routes a quarantine-tagged event to QuarantineEventStrategy regardless of kind', () => {
    const factory = eventStrategyFactory(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      (() => ({})) as any,
    )

    const event = { ...makeEvent(), [ModerationQuarantineMetadataKey]: 'duplicate_burst' }
    const strategy = factory([event, {} as any])
    expect(strategy).to.be.instanceOf(QuarantineEventStrategy)
  })

  it('routes a clean event normally', () => {
    const factory = eventStrategyFactory(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      (() => ({})) as any,
    )

    const strategy = factory([makeEvent(), {} as any])
    expect(strategy).to.be.instanceOf(DefaultEventStrategy)
  })
})

describe('QuarantineEventStrategy', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('stores into quarantine, emits OK true, and never broadcasts', async () => {
    const eventRepository = { createQuarantined: sandbox.stub().resolves(1) } as any
    const emit = sandbox.fake()
    const webSocket = { emit } as any

    const strategy = new QuarantineEventStrategy(webSocket, eventRepository, 'link_flood')
    await strategy.execute(makeEvent())

    expect(eventRepository.createQuarantined).to.have.been.calledOnce
    const [storedEvent, reason] = eventRepository.createQuarantined.firstCall.args
    expect(reason).to.equal('link_flood')
    expect(storedEvent.id).to.equal('f'.repeat(64))
    // OK true only; no Broadcast event was emitted.
    const eventNames = emit.getCalls().map((call: any) => call.args[0])
    expect(eventNames).to.not.include('broadcast')
    expect(eventNames).to.not.include('Broadcast')
  })
})
