// WebSockets: the ONE real-time mechanism (no SSE, no polling). Rooms are
// `board:<hackathonId>` and `team:<teamId>`; the client subscribes after
// connecting and refetches its data on any event for its room, so the
// server stays the source of truth and payloads stay small — the event
// only has to say WHAT changed, not carry the new state.
//
// Protocol (agreed with the client):
//   client → {"type": "subscribe", "room": "board:<hackathonId>"}
//   client → {"type": "unsubscribe", "room": "team:<teamId>"}
//   server → {"type": "team.created", "teamId": ..., "hackathonId": ..., ...}
//
// Events: team.created, team.updated, team.deleted, member.joined,
// member.left, request.created, request.decided, board.updated.
//
// Rooms live in process memory — the single-instance limitation, shared
// with the board cache and rate limits (see docs/design-doc.md).

import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

export type WsEvent = { type: string; [key: string]: unknown }

const rooms = new Map<string, Set<WebSocket>>()

const ROOM_PATTERN = /^(board|team):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function joinRoom(room: string, socket: WebSocket): void {
  let members = rooms.get(room)
  if (!members) {
    members = new Set()
    rooms.set(room, members)
  }
  members.add(socket)
}

function leaveAllRooms(socket: WebSocket): void {
  for (const [room, members] of rooms) {
    members.delete(socket)
    if (members.size === 0) rooms.delete(room)
  }
}

export function attachHub(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let data: unknown
      try {
        data = JSON.parse(raw.toString())
      } catch {
        return // Malformed frames are ignored, never fatal.
      }
      const msg = data as { type?: unknown; room?: unknown }
      if (typeof msg.room !== 'string' || !ROOM_PATTERN.test(msg.room)) return
      if (msg.type === 'subscribe') joinRoom(msg.room, socket)
      if (msg.type === 'unsubscribe') rooms.get(msg.room)?.delete(socket)
    })
    socket.on('close', () => leaveAllRooms(socket))
    socket.on('error', () => leaveAllRooms(socket))
  })
}

/** Push one event to every socket in a room. Dead sockets are dropped. */
export function broadcast(room: string, event: WsEvent): void {
  const members = rooms.get(room)
  if (!members) return
  const payload = JSON.stringify(event)
  for (const socket of members) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload)
    } else {
      members.delete(socket)
    }
  }
}

/**
 * A team mutation touches two rooms: the team room gets the specific
 * event, and the board room gets the same event PLUS board.updated (the
 * board's content changed — seats, members, or the team list itself).
 * The client refetches on either, so a double event is just one extra
 * cheap refetch of a cached board.
 */
export function emitTeamMutation(
  hackathonId: string,
  teamId: string,
  event: WsEvent,
): void {
  broadcast(`team:${teamId}`, event)
  broadcast(`board:${hackathonId}`, event)
  broadcast(`board:${hackathonId}`, { type: 'board.updated', hackathonId, teamId })
}

/** A change that only the team room cares about (e.g. a new join request). */
export function emitTeamOnly(teamId: string, event: WsEvent): void {
  broadcast(`team:${teamId}`, event)
}
