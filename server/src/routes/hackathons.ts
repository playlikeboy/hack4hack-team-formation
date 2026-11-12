// Hackathons and the public board. Both endpoints are public — the board
// is the shop window, and it must work before anyone logs in.

import { Hono } from 'hono'
import { pool } from '../db/pool'
import { notFound } from '../lib/errors'
import { boardQuerySchema, parseQuery, parseUuidParam } from '../lib/validation'
import { hackathonOut } from '../lib/serialize'
import type { AppEnv } from '../lib/env'
import { getBoard, getDefaultPagePayload, isDefaultPage } from '../services/board'
import { getHackathonRow } from '../services/teams'

export const hackathonRoutes = new Hono<AppEnv>()

hackathonRoutes.get('/', async (c) => {
  const { rows } = await pool.query('SELECT * FROM hackathons ORDER BY created_at ASC')
  return c.json(rows.map(hackathonOut))
})

hackathonRoutes.get('/:id/board', async (c) => {
  const id = parseUuidParam(c.req.param('id'), 'Hackathon')
  // A board for a hackathon that does not exist is a 404, not an empty
  // board — an empty board is a real state (no teams yet), and the two
  // must not be confused.
  if (!(await getHackathonRow(pool, id))) throw notFound('Hackathon not found.')
  const q = parseQuery(c.req.query(), boardQuerySchema)
  // The default page is pre-serialized: serve the gzip bytes when the
  // client accepts gzip, else the plain JSON string. Setting
  // Content-Encoding makes hono/compress skip this response (it never
  // re-compresses). Other windows paginate from the cached board object.
  if (isDefaultPage(q)) {
    const payload = await getDefaultPagePayload(id)
    if ((c.req.header('Accept-Encoding') ?? '').includes('gzip')) {
      return new Response(payload.gzip, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': String(payload.gzip.length),
        },
      })
    }
    return new Response(payload.json, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload.json)),
      },
    })
  }
  const board = await getBoard(id)
  return c.json({
    teams: board.teams.slice(q.teamsOffset, q.teamsOffset + q.teamsLimit),
    seekers: board.seekers.slice(q.seekersOffset, q.seekersOffset + q.seekersLimit),
    totalTeams: board.teams.length,
    totalSeekers: board.seekers.length,
  })
})
