import { PassThrough } from 'stream'
import { EventKinds } from '../constants/base'
import { DatabaseClient, EventId, Pubkey } from './base'
import { DvmJob } from './dvm'
import { DBEvent, Event } from './event'
import { CreateInviteCodeOptions, InviteCode } from './invite-code'
import { Invoice } from './invoice'
import { Nip05Verification } from './nip05'
import { EventKindsRange } from './settings'
import { SubscriptionFilter } from './subscription'
import { User } from './user'

export interface EventRetentionOptions {
  maxDays?: number
  kindWhitelist?: (EventKinds | EventKindsRange)[]
  pubkeyWhitelist?: Pubkey[]
}

export interface EventPurgeCounts {
  deleted: number
  expired: number
  retained: number
}

export type ExposedPromiseKeys = 'then' | 'catch' | 'finally'

export interface IQueryResult<T> extends Pick<Promise<T>, keyof Promise<T> & ExposedPromiseKeys> {
  stream(options?: Record<string, any>): PassThrough & AsyncIterable<T>
}

export interface QuarantineListOptions {
  limit?: number
  offset?: number
}

export interface IEventRepository {
  create(event: Event): Promise<number>
  createMany(events: Event[]): Promise<number>
  upsert(event: Event): Promise<number>
  upsertMany(events: Event[]): Promise<number>
  findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]>
  countByFilters(filters: SubscriptionFilter[]): Promise<number>
  deleteByPubkeyAndIds(pubkey: Pubkey, ids: EventId[]): Promise<number>
  deleteByPubkeyExceptKinds(pubkey: Pubkey, excludedKinds: number[]): Promise<number>
  hasActiveRequestToVanish(pubkey: Pubkey): Promise<boolean>
  deleteExpiredAndRetained(options?: EventRetentionOptions): Promise<EventPurgeCounts>
  /** Insert a newly received event directly into quarantine (not published). */
  createQuarantined(event: Event, reason: string): Promise<number>
  /** Quarantined events awaiting review, newest first. */
  listQuarantined(options?: QuarantineListOptions): Promise<DBEvent[]>
  /** A single quarantined event by id, or undefined. */
  findQuarantined(eventId: EventId): Promise<DBEvent | undefined>
  /** Overturn (restore) a quarantined event, recording the reviewer. */
  overturnQuarantine(eventId: EventId, reviewerPubkey: Pubkey): Promise<number>
  /** Hard-delete a specific quarantined event immediately. */
  deleteQuarantined(eventId: EventId): Promise<number>
  /** Hard-delete quarantined events older than the window and not overturned. */
  purgeExpiredQuarantines(windowSeconds: number):Promise<number>
  /** Count of events currently awaiting review. */
  countQuarantined(): Promise<number>
}


export interface IInvoiceRepository {
  findById(id: string, client?: DatabaseClient): Promise<Invoice | undefined>
  upsert(invoice: Partial<Invoice>, client?: DatabaseClient): Promise<number>
  updateStatus(invoice: Pick<Invoice, 'id' | 'status'>, client?: DatabaseClient): Promise<Invoice | undefined>
  confirmInvoice(invoiceId: string, amountReceived: bigint, confirmedAt: Date, client?: DatabaseClient): Promise<void>
  findPendingInvoices(offset?: number, limit?: number, client?: DatabaseClient): Promise<Invoice[]>
}

export interface IUserRepository {
  findByPubkey(pubkey: Pubkey, client?: DatabaseClient): Promise<User | undefined>
  upsert(user: Partial<User>, client?: DatabaseClient): Promise<number>
  getBalanceByPubkey(pubkey: Pubkey, client?: DatabaseClient): Promise<bigint>
  isVanished(pubkey: Pubkey, client?: DatabaseClient): Promise<boolean>
  setVanished(pubkey: Pubkey, vanished: boolean, client?: DatabaseClient): Promise<number>
  admitUser(pubkey: Pubkey, admittedAt: Date, client?: DatabaseClient): Promise<void>
  revokeAdmission(pubkey: Pubkey, client?: DatabaseClient): Promise<number>
}

export interface INip05VerificationRepository {
  findByPubkey(pubkey: Pubkey): Promise<Nip05Verification | undefined>
  upsert(verification: Nip05Verification): Promise<number>
  findPendingVerifications(updateFrequencyMs: number, maxFailures: number, limit: number): Promise<Nip05Verification[]>
  deleteByPubkey(pubkey: Pubkey): Promise<number>
}

export interface IInviteCodeRepository {
  create(code: string, options?: CreateInviteCodeOptions): Promise<InviteCode>
  findByCode(code: string): Promise<InviteCode | undefined>
  claimCode(code: string, pubkey: Pubkey): Promise<boolean>
  findActiveCodes(limit?: number): Promise<InviteCode[]>
  deleteExpiredCodes(): Promise<number>
}

export interface IDvmJobRepository {
  create(id: string, requesterPubkey: Pubkey, kind: number): Promise<DvmJob>
  findById(id: string): Promise<DvmJob | undefined>
  assignWorker(id: string, workerIndex: number): Promise<boolean>
  updateStatus(
    job: Pick<DvmJob, 'id' | 'status'> & Partial<Pick<DvmJob, 'resultEventId' | 'error'>>,
  ): Promise<DvmJob | undefined>
  findPendingJobs(limit?: number, kinds?: number[]): Promise<DvmJob[]>
}
