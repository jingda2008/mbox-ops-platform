import { randomUUID } from 'node:crypto'
import type { RuntimeState, Table } from '../src/shared/contracts.js'
import type { SongTableSession } from '../src/shared/song-contracts.js'

export function openTableSessions(state: RuntimeState, tableId: string) {
  return state.songState.tableSessions.filter((session) => session.tableId === tableId && session.status === 'open')
}

export function currentOpenTableSession(state: RuntimeState, tableId: string) {
  const sessions = openTableSessions(state, tableId)
  if (sessions.length !== 1) {
    throw new Error(sessions.length === 0 ? '桌台没有开放桌次' : '桌台存在重复开放桌次')
  }
  return sessions[0]!
}

export function openTableSession(state: RuntimeState, table: Table, openedAt: string): SongTableSession {
  if (openTableSessions(state, table.id).length > 0) throw new Error('桌台已经存在开放桌次')
  const session: SongTableSession = {
    id: `session:${table.id}:${state.store.businessDate}:${randomUUID()}`,
    tableId: table.id,
    tableCode: table.code,
    status: 'open',
    openedAt,
    closedAt: null,
  }
  state.songState.tableSessions.push(session)
  return session
}
