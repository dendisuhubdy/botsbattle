import { hash, verify } from '@node-rs/argon2'

// `Algorithm.Argon2id` is an ambient const enum, which `isolatedModules` forbids importing.
// 2 is its value, and it is also this library's default — passing it explicitly documents
// that the choice is deliberate rather than inherited.
const ARGON2ID = 2

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain, OPTIONS)
  } catch {
    return false
  }
}
