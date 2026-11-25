import 'pg'
import 'pg-query-stream'
import knex, { Knex } from 'knex'
import { createLogger } from '../factories/logger-factory'

const poolLogger = createLogger('database-client:pool-monitor')

;((knex) => {
  const lastUpdate = {}
  knex.Client.prototype.releaseConnection = function (connection) {
    const released = this.pool.release(connection)

    if (released) {
      const now = new Date().getTime()
      const { tag } = this.config
      lastUpdate[tag] = lastUpdate[tag] ?? now
      if (now - lastUpdate[tag] >= 60000) {
        lastUpdate[tag] = now
        poolLogger.info(`${tag} connection pool: ${this.pool.numUsed()} used / ${this.pool.numFree()} free / ${this.pool.numPendingAcquires()} pending`)
      }
    }

    return Promise.resolve()
  }
})(knex)

const getMasterConfig = (): Knex.Config =>
  ({
    tag: 'master',
    client: 'pg',
    connection: process.env.DB_URI
      ? process.env.DB_URI
      : {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        },
    pool: {
      min: process.env.DB_MIN_POOL_SIZE ? Number(process.env.DB_MIN_POOL_SIZE) : 0,
      max: process.env.DB_MAX_POOL_SIZE ? Number(process.env.DB_MAX_POOL_SIZE) : 3,
      idleTimeoutMillis: 60000,
      propagateCreateError: false,
      acquireTimeoutMillis: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
        ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
        : 60000,
    },
    acquireConnectionTimeout: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
      ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
      : 60000,
  }) as any

const DEFAULT_READ_STATEMENT_TIMEOUT_MS = 60000

const getReadReplicaConfigByIndex = (index: number): Knex.Config => {
  const statementTimeout = process.env[`RR${index}_DB_STATEMENT_TIMEOUT_MS`]
  const applicationName = process.env[`RR${index}_DB_APPLICATION_NAME`] || `nostream-read-${index}`

  return {
    tag: 'read-replica',
    client: 'pg',
    connection: {
      host: process.env[`RR${index}_DB_HOST`],
      port: Number(process.env[`RR${index}_DB_PORT`]),
      user: process.env[`RR${index}_DB_USER`],
      password: process.env[`RR${index}_DB_PASSWORD`],
      database: process.env[`RR${index}_DB_NAME`],
      // Makes stale relay reads easy to identify in pg_stat_activity.
      application_name: applicationName,
      // Cap long-running query execution. This does NOT cover a backend
      // blocked in ClientRead: PostgreSQL does not check statement_timeout
      // while it is waiting for a client to consume result rows. Aborted
      // streams are therefore closed at the portal level in
      // patches/knex@2.4.2.patch, and the stale-read watchdog is the final
      // backstop. This timeout still bounds genuinely long CPU/IO work.
      statement_timeout: statementTimeout ? Number(statementTimeout) : DEFAULT_READ_STATEMENT_TIMEOUT_MS,
    },
    pool: {
      min: process.env[`RR${index}_DB_MIN_POOL_SIZE`] ? Number(process.env[`RR${index}_DB_MIN_POOL_SIZE`]) : 0,
      max: process.env[`RR${index}_DB_MAX_POOL_SIZE`] ? Number(process.env[`RR${index}_DB_MAX_POOL_SIZE`]) : 3,
      idleTimeoutMillis: 60000,
      propagateCreateError: false,
      acquireTimeoutMillis: process.env[`RR${index}_DB_ACQUIRE_CONNECTION_TIMEOUT`]
        ? Number(process.env[`RR${index}_DB_ACQUIRE_CONNECTION_TIMEOUT`])
        : 60000,
    },
  } as any
}

const getReadReplicaConfig = (): Knex.Config => {
  // Workers other than the pool-based `worker` type (maintenance, dvm,
  // mirroring) are forked without WORKER_INDEX. `Number(undefined) % n` is
  // NaN, which selected an undefined RRNaN_DB_* config and crashed those
  // workers on connect (they only survived because READ_REPLICA_ENABLED
  // defaulted to false). Fall back to index 0 when WORKER_INDEX is unset.
  const rawIndex = process.env.WORKER_INDEX
  const replicaCount = Number(process.env.READ_REPLICAS)
  const readReplicaIndex =
    rawIndex === undefined || !Number.isFinite(replicaCount) || replicaCount <= 0
      ? 0
      : Number(rawIndex) % replicaCount

  return getReadReplicaConfigByIndex(readReplicaIndex)
}

let writeClient: Knex

export const getMasterDbClient = () => {
  const logger = createLogger('database-client:get-db-client')
  if (!writeClient) {
    const config = getMasterConfig()
    logger('config: %o', config)
    writeClient = knex(config)
  }

  return writeClient
}

let readClient: Knex

export const getReadReplicaDbClient = () => {
  if (process.env.READ_REPLICA_ENABLED !== 'true') {
    return getMasterDbClient()
  }

  const logger = createLogger('database-client:get-read-replica-db-client')
  if (!readClient) {
    const config = getReadReplicaConfig()
    logger('config: %o', config)
    readClient = knex(config)
  }

  return readClient
}
