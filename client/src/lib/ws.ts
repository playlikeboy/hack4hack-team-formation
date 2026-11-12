// WebSocket live updates — the one real-time mechanism (contract: no SSE,
// no polling). The client subscribes to a room and the server pushes events;
// on any event for our room we simply refetch the affected data. Refetching
// instead of applying the event payload keeps the UI correct even if an event
// arrives out of order or a payload shape changes — the server stays the
// source of truth and the board cache makes refetches cheap.
//
// Subscribe protocol (agreed with the backend track): after connecting, send
//   {"type":"subscribe","room":"board:<hackathonId>"}
// or
//   {"type":"subscribe","room":"team:<teamId>"}
// The server then pushes events of the form {"type":"team.created", ...}.

import { useEffect, useRef, useState } from 'react'

export type WsStatus = 'connecting' | 'live' | 'offline'

export const BOARD_EVENTS = new Set([
  'team.created',
  'team.updated',
  'team.deleted',
  'member.joined',
  'member.left',
  'request.created',
  'request.decided',
  'board.updated',
])

function wsUrl(): string {
  // Same origin as the page in production; the Vite dev proxy forwards /ws.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

/**
 * Subscribe to one room. `onEvent` fires for every event the server pushes
 * for that room; callers typically refetch their data in response.
 * Reconnects with backoff if the socket drops, and re-subscribes on reconnect.
 */
export function useRoom(room: string | null, onEvent: (type: string) => void): WsStatus {
  const [status, setStatus] = useState<WsStatus>('connecting')
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!room) {
      setStatus('offline')
      return
    }

    let socket: WebSocket | null = null
    let closed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const connect = () => {
      if (closed) return
      setStatus('connecting')
      socket = new WebSocket(wsUrl())

      socket.addEventListener('open', () => {
        attempt = 0
        setStatus('live')
        socket?.send(JSON.stringify({ type: 'subscribe', room }))
      })

      socket.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data as string) as { type?: unknown }
          if (typeof data.type === 'string' && BOARD_EVENTS.has(data.type)) {
            onEventRef.current(data.type)
          }
        } catch {
          // Ignore malformed frames — the next refetch still keeps us correct.
        }
      })

      const scheduleReconnect = () => {
        if (closed) return
        setStatus('offline')
        // Backoff: 1s, 2s, 4s … capped at 30s.
        const delay = Math.min(1000 * 2 ** attempt, 30000)
        attempt += 1
        retryTimer = setTimeout(connect, delay)
      }

      socket.addEventListener('close', scheduleReconnect)
      socket.addEventListener('error', () => {
        // 'close' follows 'error'; the reconnect is scheduled there.
        socket?.close()
      })
    }

    connect()

    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      socket?.close()
    }
  }, [room])

  return status
}
