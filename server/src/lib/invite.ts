// Invite codes: 8 characters from an unambiguous alphabet (no 0/O, 1/I/l,
// so a code read aloud or typed from a screenshot cannot be misread).
// 32^8 ≈ 2^40 — short enough to type, long enough that brute force is
// infeasible at 5 attempts per IP per 10 minutes. The rate limit, not the
// alphabet, is the real defence (see docs/design-doc.md).

import { randomInt } from 'node:crypto'

export const INVITE_CODE_LENGTH = 8
export const INVITE_TTL_DAYS = 7

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateInviteCode(): string {
  let code = ''
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  return code
}

export function inviteExpiry(from = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
}
