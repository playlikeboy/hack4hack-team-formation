// k6 board pass: 100 virtual users hitting the default board page for 30s.
// k6 reports exact p(95), which autocannon does not. Same conditions as the
// autocannon board pass (same server, same seeded dataset) so the numbers
// are comparable. Run:
//
//   HACKATHON_ID=<id> k6 run load/board-k6.js
//   LOAD_BASE_URL=https://<deployed-space> HACKATHON_ID=<id> k6 run load/board-k6.js
//
// The server must already be running against a seeded database, and the
// board cache should be warm (hit the board URL once first).

import http from 'k6/http'
import { check } from 'k6'

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://127.0.0.1:3000'
const HACKATHON_ID = __ENV.HACKATHON_ID

if (!HACKATHON_ID) {
  throw new Error('HACKATHON_ID is required — fetch it from GET /api/hackathons')
}

export const options = {
  vus: 100,
  duration: '30s',
}

export default function () {
  const res = http.get(`${BASE_URL}/api/hackathons/${HACKATHON_ID}/board`)
  check(res, { 'status 200': (r) => r.status === 200 })
}
