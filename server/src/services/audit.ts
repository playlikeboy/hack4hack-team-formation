// Audit log: every team mutation writes one row (who, what, when). The
// team page shows the last 50 to members; GET /api/teams/:id/audit returns
// the full list to members. Details carry human-readable names (not just
// ids) so the log reads like a story: "Aarav joined the team".

import type { PoolClient } from 'pg'

export interface AuditEntry {
  teamId: string | null
  actorId: string
  action: string
  details?: Record<string, unknown>
}

export async function audit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (team_id, actor_id, action, details)
     VALUES ($1, $2, $3, $4)`,
    [entry.teamId, entry.actorId, entry.action, JSON.stringify(entry.details ?? {})],
  )
}
