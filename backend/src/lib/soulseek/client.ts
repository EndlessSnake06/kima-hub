/**
 * Soulseek client selection: the slskd REST adapter or the built-in P2P client.
 * The `_p2p`/`_slskd` assignments make the build fail if either drifts from
 * ISlskClient.
 */

import type { EventEmitter } from 'events'
import { SlskClient as P2PClient } from './p2p-client'
import { SlskdClient } from './slskd-client'
import type { Download } from './downloads'
import type { FileSearchResponse } from './messages/from/peer'

/** Options accepted by a Soulseek search (shared by both backends). */
interface SlskSearchOptions {
  timeout?: number
  onResult?: (result: FileSearchResponse) => void
  maxResponses?: number
}

/** Minimal surface of the server connection that SoulseekService reads. */
interface SlskServerConn {
  once(event: string, listener: (...args: any[]) => void): unknown
  readonly destroyed: boolean
  readonly writable: boolean
}

/** What SoulseekService calls on a client, and nothing more, so the two backends stay interchangeable. */
export interface ISlskClient extends EventEmitter {
  loggedIn: boolean
  downloads: Download[]
  server: { conn: SlskServerConn }
  login(username: string, password: string, timeout?: number): Promise<void>
  search(query: string, opts?: SlskSearchOptions): Promise<FileSearchResponse[]>
  download(username: string, filename: string, receivedBytes?: bigint | number): Promise<Download>
  removeDownload(download: Download): void
  destroy(): void
}

// These assignments fail the build if either backend drifts from ISlskClient.
const _p2p: new () => ISlskClient = P2PClient
const _slskd: new () => ISlskClient = SlskdClient

/** The backend for an explicit mode ("slskd" or "p2p"); any other mode follows SLSKD_URL. */
export function resolveSlskClient(mode?: string | null): new () => ISlskClient {
  if (mode === 'slskd') return _slskd
  if (mode === 'p2p') return _p2p
  return process.env.SLSKD_URL ? _slskd : _p2p
}

export const SlskClient: new () => ISlskClient = resolveSlskClient()
