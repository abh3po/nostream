import cluster from 'cluster'
import { EventEmitter } from 'stream'
import { IncomingMessage as IncomingHttpMessage } from 'http'
import { WebSocket } from 'ws'
import { ZodError } from 'zod'

import { ContextMetadata, Factory } from '../@types/base'
import { createAuthChallengeMessage, createCommandResult, createNoticeMessage, createOutgoingEventMessage } from '../utils/messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { IncomingMessage, MessageType, OutgoingMessage } from '../@types/messages'
import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { attemptValidation } from '../utils/validation'
import { ContextMetadataKey } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { recordWebsocketConnectionClosed, recordWebsocketConnectionOpened } from '../telemetry/event-metrics'
import { Event } from '../@types/event'
import { getRemoteAddress } from '../utils/http'
import { createReadAuthorizationGuard } from '../utils/nip42'
import { Nip42SessionManager } from '../utils/nip42-session'
import { IRateLimiter, IRateLimitResult } from '../@types/utils'
import { isEventMatchingFilter } from '../utils/event'
import { messageSchema } from '../schemas/message-schema'
import { Settings } from '../@types/settings'
import { SocketAddress } from 'net'

const logger = createLogger('web-socket-adapter')
const debugHeartbeat = logger.extend('heartbeat')

/**
 * Human-readable rate-limit reason, including how long to wait.
 *
 * The `rate-limited:` prefix mirrors the machine-readable `auth-required:`
 * convention NIP-42 uses elsewhere in this file, so a client can match on it.
 * The wait is rounded to whole seconds (never below 1) because that is the
 * granularity a client can sensibly act on.
 */
const describeRateLimit = (retryAfterMs?: number): string => {
  if (retryAfterMs === undefined || retryAfterMs <= 0) {
    return 'rate-limited: too many messages, slow down'
  }
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return `rate-limited: too many messages, retry in ${seconds}s`
}

const abortableMessageHandlers: WeakMap<WebSocket, IAbortable[]> = new WeakMap()

export class WebSocketAdapter extends EventEmitter implements IWebSocketAdapter {
  public clientId: string
  private clientAddress: SocketAddress
  private alive: boolean
  private subscriptions: Map<SubscriptionId, SubscriptionFilter[]>
  private readonly session: Nip42SessionManager
  /** True once the NIP-42 challenge has been sent on this socket. */
  private authChallengeSent: boolean

  public constructor(
    private readonly client: WebSocket,
    private readonly request: IncomingHttpMessage,
    private readonly webSocketServer: IWebSocketServerAdapter,
    private readonly createMessageHandler: Factory<IMessageHandler, [IncomingMessage, IWebSocketAdapter]>,
    private readonly rateLimiter: Factory<IRateLimiter>,
    private readonly settings: Factory<Settings>,
  ) {
    super()
    this.alive = true
    this.authChallengeSent = false
    this.subscriptions = new Map()

    this.clientId = Buffer.from(this.request.headers['sec-websocket-key'] as string, 'base64').toString('hex')

    const address = getRemoteAddress(this.request, this.settings())

    this.clientAddress = new SocketAddress({
      address: address,
      family: address.indexOf(':') >= 0 ? 'ipv6' : 'ipv4',
    })

    this.client
      .on('error', (error) => {
        if (error.name === 'RangeError' && error.message === 'Max payload size exceeded') {
          logger.error(`web-socket-adapter: client ${this.clientId} (${this.getClientAddress()}) sent payload too large`)
        } else if (error.name === 'RangeError' && error.message === 'Invalid WebSocket frame: RSV1 must be clear') {
          logger(`client ${this.clientId} (${this.getClientAddress()}) enabled compression`)
        } else {
          logger.error(`web-socket-adapter: client error ${this.clientId} (${this.getClientAddress()}):`, error)
        }

        this.client.close()
      })
      .on('message', this.onClientMessage.bind(this))
      .on('close', this.onClientClose.bind(this))
      .on('pong', this.onClientPong.bind(this))
      .on('ping', this.onClientPing.bind(this))

    this.on(WebSocketAdapterEvent.Heartbeat, this.onHeartbeat.bind(this))
      .on(WebSocketAdapterEvent.Subscribe, this.onSubscribed.bind(this))
      .on(WebSocketAdapterEvent.Unsubscribe, this.onUnsubscribed.bind(this))
      .on(WebSocketAdapterEvent.Event, this.onSendEvent.bind(this))
      .on(WebSocketAdapterEvent.Broadcast, this.onBroadcast.bind(this))
      .on(WebSocketAdapterEvent.Message, this.sendMessage.bind(this))

    logger('client %s connected from %s', this.clientId, this.clientAddress.address)
    recordWebsocketConnectionOpened()

    // NIP-42: challenge-response session for this socket. The challenge is not
    // sent here. Clients that auto-sign on seeing an AUTH message would produce
    // a flurry of signer prompts for a relay that rarely needs auth, so the
    // challenge is sent lazily, immediately before the first `auth-required`
    // response (see sendMessage). NIP-42 explicitly permits this: the client
    // only needs a stored challenge by the time it acts on `auth-required`.
    this.session = new Nip42SessionManager(() => this.settings().nip42?.sessionExpirySeconds)
  }

  public getClientId(): string {
    return this.clientId
  }

  public getClientAddress(): string {
    return this.clientAddress.address
  }

  public onUnsubscribed(subscriptionId: string): void {
    logger('client %s unsubscribed %s', this.clientId, subscriptionId)
    this.subscriptions.delete(subscriptionId)
  }

  public onSubscribed(subscriptionId: string, filters: SubscriptionFilter[]): void {
    logger('client %s subscribed %s to %o', this.clientId, subscriptionId, filters)
    this.subscriptions.set(subscriptionId, filters)
  }

  public onBroadcast(event: Event): void {
    this.webSocketServer.emit(WebSocketServerAdapterEvent.Broadcast, event)
    if (cluster.isWorker && typeof process.send === 'function') {
      process.send({
        eventName: WebSocketServerAdapterEvent.Broadcast,
        event,
      })
    }
  }

  public onSendEvent(event: Event): void {
    // NIP-42: don't broadcast restricted-kind events to unauthorized clients.
    const isReadAuthorized = createReadAuthorizationGuard(this.settings(), () => this.session.getAuthenticatedPubkeys())
    if (!isReadAuthorized(event)) {
      return
    }

    this.subscriptions.forEach((filters, subscriptionId) => {
      if (filters.map(isEventMatchingFilter).some((isMatch) => isMatch(event))) {
        logger('sending event to client %s: %o', this.clientId, event)
        this.sendMessage(createOutgoingEventMessage(subscriptionId, event))
      }
    })
  }

  private sendMessage(message: OutgoingMessage): void {
    if (this.client.readyState !== WebSocket.OPEN) {
      return
    }

    // NIP-42: whenever we are about to tell a client that auth is required,
    // ensure it has a challenge to sign. The challenge is sent just before the
    // `auth-required` CLOSED/OK so clients that auto-sign on AUTH never see one
    // unless they actually hit a restricted action. Send at most once per
    // socket; the challenge is valid for the connection's lifetime.
    if (!this.authChallengeSent && isAuthRequiredResponse(message)) {
      this.authChallengeSent = true
      this.client.send(JSON.stringify(createAuthChallengeMessage(this.session.getChallenge())))
    }

    this.client.send(JSON.stringify(message))
  }

  public onHeartbeat(): void {
    if (!this.alive) {
      logger.error(`web-socket-adapter: pong timeout for client ${this.clientId} (${this.getClientAddress()})`)
      this.client.close()
      return
    }

    this.alive = false
    this.client.ping()
    debugHeartbeat('client %s ping', this.clientId)
  }

  public getSubscriptions(): Map<string, SubscriptionFilter[]> {
    return new Map(this.subscriptions)
  }

  // NIP-42
  public getChallenge(): string {
    return this.session.getChallenge()
  }

  public getAuthenticatedPubkeys(): ReadonlySet<string> {
    return this.session.getAuthenticatedPubkeys()
  }

  public addAuthenticatedPubkey(pubkey: string, authEventId: string): boolean {
    // Keep the existing challenge. NIP-42 allows multiple AUTH events on one
    // socket to share it; rotating here would break pipelined multi-pubkey auth.
    return this.session.authenticate(pubkey, authEventId)
  }

  private async onClientMessage(raw: Buffer) {
    this.alive = true
    let abortable = false
    let messageHandler: (IMessageHandler & IAbortable) | undefined = undefined
    try {
      const rateLimited = await this.getRateLimit(this.clientAddress.address)
      if (rateLimited.limited) {
        // A rate-limited EVENT must still get a NIP-20 OK. Clients wait for one
        // before considering a publish sent, so replying with only a NOTICE
        // leaves them hanging until their own timeout (measured: a real client
        // waited indefinitely, never receiving OK). The OK carries accepted=false
        // plus how long to wait, which a client can act on.
        const rejected = this.replyRateLimitedEvent(raw, rateLimited.retryAfterMs)
        if (!rejected) {
          // Not an EVENT (REQ/CLOSE/COUNT...): a NOTICE is the right reply, and
          // still reports the wait so the client can pace itself.
          this.sendMessage(createNoticeMessage(describeRateLimit(rateLimited.retryAfterMs)))
        }
        return
      }

      const message = attemptValidation(messageSchema)(JSON.parse(raw.toString('utf8')))

      message[ContextMetadataKey] = {
        remoteAddress: this.clientAddress,
      } as ContextMetadata

      messageHandler = this.createMessageHandler([message, this]) as IMessageHandler & IAbortable
      if (!messageHandler) {
        logger.error('web-socket-adapter: unhandled message: no handler found:', message)
        return
      }

      abortable = typeof messageHandler.abort === 'function'

      if (abortable) {
        const handlers = abortableMessageHandlers.get(this.client) ?? []
        handlers.push(messageHandler)
        abortableMessageHandlers.set(this.client, handlers)
      }

      await messageHandler.handleMessage(message)
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.error(`web-socket-adapter: abort from client ${this.clientId} (${this.getClientAddress()})`)
        } else if (error.name === 'SyntaxError' || error instanceof ZodError) {
          logger('invalid message client %s (%s): %s', this.clientId, this.getClientAddress(), error.message)
          const notice =
            error instanceof ZodError
              ? `invalid: ${error.issues[0]?.message ?? error.message}`
              : `invalid: ${error.message}`
          this.sendMessage(createNoticeMessage(notice))
        } else {
          logger.error('web-socket-adapter: unable to handle message:', error)
        }
      } else {
        logger.error('web-socket-adapter: unable to handle message:', error)
      }
    } finally {
      if (abortable && messageHandler) {
        const handlers = abortableMessageHandlers.get(this.client)
        if (handlers) {
          const index = handlers.indexOf(messageHandler)
          if (index >= 0) {
            handlers.splice(index, 1)
          }
        }
      }
    }
  }

  /**
   * Checks every configured message rate limit for this client.
   *
   * Returns the longest wait implied by any limit that was exceeded, so the
   * client is told the worst case rather than whichever limit happened to be
   * evaluated last.
   */
  private async getRateLimit(client: string): Promise<IRateLimitResult> {
    const { rateLimits, ipWhitelist = [] } = this.settings().limits?.message ?? {}

    if (!Array.isArray(rateLimits) || !rateLimits.length || ipWhitelist.includes(client)) {
      return { limited: false }
    }

    const rateLimiter = this.rateLimiter()

    let longestWait: number | undefined

    for (const { rate, period } of rateLimits) {
      const key = `${client}:message:${period}`
      // `check` reports the wait when the limiter implements it; the interface
      // marks it optional so a custom limiter can stay on the boolean API.
      const result = rateLimiter.check
        ? await rateLimiter.check(key, 1, { period, rate })
        : { limited: await rateLimiter.hit(key, 1, { period, rate }) }

      if (result.limited) {
        logger('rate limited %s: %d messages / %d ms exceeded', client, rate, period)
        const wait = result.retryAfterMs ?? period
        longestWait = longestWait === undefined ? wait : Math.max(longestWait, wait)
      }
    }

    return longestWait === undefined
      ? { limited: false }
      : { limited: true, retryAfterMs: longestWait }
  }

  /**
   * Answers a rate-limited EVENT with a NIP-20 OK of `false`.
   *
   * Returns whether the raw frame was an EVENT (and so was answered). Non-EVENT
   * messages fall through to a NOTICE. Parsing is defensive: a malformed or
   * unidentifiable frame returns false rather than throwing, because this runs
   * on the rejection path where raising would lose the reply entirely.
   */
  private replyRateLimitedEvent(raw: Buffer, retryAfterMs?: number): boolean {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return false
    }
    if (!Array.isArray(parsed) || parsed[0] !== MessageType.EVENT) {
      return false
    }
    const event = parsed[1] as { id?: unknown } | undefined
    const eventId = typeof event?.id === 'string' ? event.id : ''

    // NIP-20 has no machine-readable retry field, so the wait goes in the
    // human-readable message; clients that parse it can back off precisely and
    // the rest still see a normal rejection.
    this.sendMessage(createCommandResult(eventId, false, describeRateLimit(retryAfterMs)))
    return true
  }

  private onClientPong() {
    debugHeartbeat('client %s pong', this.clientId)
    this.alive = true
  }

  private onClientPing(data: any) {
    debugHeartbeat('client %s ping', this.clientId)
    this.client.pong(data)
    this.alive = true
  }

  private onClientClose() {
    recordWebsocketConnectionClosed()
    this.alive = false
    this.subscriptions.clear()
    this.session.clear()

    const handlers = abortableMessageHandlers.get(this.client)
    if (Array.isArray(handlers) && handlers.length) {
      for (const handler of handlers) {
        try {
          handler.abort()
        } catch (error) {
          logger.error('Unable to abort message handler', error)
        }
      }
    }

    this.removeAllListeners()
    this.client.removeAllListeners()
  }
}

/**
 * True when an outgoing message tells the client that NIP-42 auth is required,
 * i.e. a CLOSED/OK carrying the machine-readable `auth-required:` prefix
 * (NIP-42). Such a response must be preceded by an AUTH challenge so the client
 * can act on it.
 */
const isAuthRequiredResponse = (message: OutgoingMessage): boolean => {
  // CLOSED is [type, subscriptionId, reason]; OK is [type, eventId, ok, reason].
  const type = message[0]
  if (type !== MessageType.CLOSED && type !== MessageType.OK) {
    return false
  }
  const reason = type === MessageType.CLOSED ? message[2] : message[3]
  return typeof reason === 'string' && reason.startsWith('auth-required:')
}
