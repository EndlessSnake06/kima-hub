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

/**
 * The exact public surface SoulseekService depends on. Both the vendored
 * P2P client and the slskd HTTP adapter implement this. Kept deliberately
 * minimal — only what SoulseekService actually calls — so the two backends
 * stay interchangeable.
 */
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

// Compile-time contract guard. Each assignment forces TS to verify that the
// backend's instances satisfy ISlskClient; a drift produces an error at the
// specific line, so diagnostics point straight at the offending backend.
const _p2p: new () => ISlskClient = P2PClient
const _slskd: new () => ISlskClient = SlskdClient

// Select the backend by environment. The return type is the interface, not a
// concrete class, so consumers depend only on the shared contract.
export const SlskClient: new () => ISlskClient = process.env.SLSKD_URL ? _slskd : _p2p

// Resolve the backend from an explicit mode (e.g. a user setting) instead of the
// env default: "slskd" -> REST adapter, "p2p" -> built-in client. When mode is
// unset, fall back to the env-based selection above.
export function resolveSlskClient(mode?: string | null): new () => ISlskClient {
  if (mode === 'slskd') return _slskd
  if (mode === 'p2p') return _p2p
  return process.env.SLSKD_URL ? _slskd : _p2p
}

// Re-export the client events type from the P2P client for type compatibility.
export type { SlskClientEvents, SlskPeersEvents } from './p2p-client'
