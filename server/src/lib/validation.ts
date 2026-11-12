// zod schemas for every input the API accepts. Nothing from the client is
// trusted: each route parses its body/params/query through one of these and
// a bad input is a 400 before any database work happens.

import { z } from 'zod'
import { badRequest, notFound } from './errors'

export const uuidSchema = z.string().uuid('Expected a valid id.')

const skillSchema = z.string().trim().min(1).max(40)
const skillsSchema = z.array(skillSchema).max(30).default([])

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  // 8 chars minimum; scrypt makes brute force expensive, the length floor
  // keeps the weakest passwords out.
  password: z.string().min(8, 'Password must be at least 8 characters.').max(128),
  name: z.string().trim().min(1, 'Name is required.').max(80),
  skills: skillsSchema.optional(),
  timezone: z.string().trim().max(60).optional(),
  bio: z.string().max(500).optional(),
})

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
})

export const createTeamSchema = z.object({
  hackathonId: z.string().uuid(),
  name: z.string().trim().min(1, 'Team name is required.').max(80),
  description: z.string().max(500).optional(),
})

export const joinSchema = z.object({
  // Codes are stored uppercase; normalise here so "k7q2x9mp" works too.
  inviteCode: z
    .string()
    .trim()
    .toUpperCase()
    .length(8, 'Invite codes are 8 characters.'),
})

export const requestToJoinSchema = z.object({
  message: z.string().max(500).optional().default(''),
})

export const removeMemberSchema = z.object({
  userId: z.string().uuid(),
})

// Board pagination: teams and seekers page independently (the client loads
// more of one without refetching the other). Limits are capped at 200 so a
// single request can never ask for the whole 2,000-team board.
export const BOARD_DEFAULT_PAGE_SIZE = 50
export const BOARD_MAX_PAGE_SIZE = 200
export const boardQuerySchema = z.object({
  teamsLimit: z.coerce.number().int().min(1).max(BOARD_MAX_PAGE_SIZE).default(BOARD_DEFAULT_PAGE_SIZE),
  teamsOffset: z.coerce.number().int().min(0).default(0),
  seekersLimit: z.coerce.number().int().min(1).max(BOARD_MAX_PAGE_SIZE).default(BOARD_DEFAULT_PAGE_SIZE),
  seekersOffset: z.coerce.number().int().min(0).default(0),
})

export type BoardQuery = z.infer<typeof boardQuerySchema>

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type CreateTeamInput = z.infer<typeof createTeamSchema>

/** Parse a request body against a schema, or throw a 400 naming the problem. */
export async function parseBody<T>(req: Request, schema: z.ZodSchema<T>): Promise<T> {
  const raw: unknown = await req.json().catch(() => null)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    const where = first.path.length > 0 ? `${String(first.path[0])}: ` : ''
    throw badRequest('validation_error', `${where}${first.message}`)
  }
  return result.data
}

/** Parse query params against a schema, or throw a 400 naming the problem. */
export function parseQuery<T extends z.ZodTypeAny>(
  query: Record<string, string>,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(query)
  if (!result.success) {
    const first = result.error.issues[0]
    const where = first.path.length > 0 ? `${String(first.path[0])}: ` : ''
    throw badRequest('validation_error', `${where}${first.message}`)
  }
  return result.data
}

/** Parse a route param as a UUID, or throw a 404 (an invalid id is not a thing). */
export function parseUuidParam(value: string | undefined, what = 'Resource'): string {
  const result = uuidSchema.safeParse(value)
  if (!result.success) {
    // A malformed id is treated as "not found" rather than a 400: the
    // resource it names does not exist, and that is the honest answer.
    throw notFound(`${what} not found.`)
  }
  return result.data
}
