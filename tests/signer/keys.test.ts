import { describe, it, expect } from 'vitest'
import { mnemonicToSeedSync } from '@scure/bip39'
import { TronWeb } from 'tronweb'
import {
  derivePrivateKeyHex,
  deriveXpub,
  assertMatchesXpub,
  loadSignerSeed,
} from '@/lib/signer/keys'
import { deriveAddress } from '@/lib/tron/address'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)

describe('signer keys', () => {
  it('derives a key whose address matches the xpub-derived address', () => {
    const xpub = deriveXpub(SEED)
    for (let i = 0; i < 10; i++) {
      const priv = derivePrivateKeyHex(SEED, i)
      expect(TronWeb.address.fromPrivateKey(priv)).toBe(deriveAddress(xpub, i))
    }
  })

  it('produces a 64-character hex private key', () => {
    expect(derivePrivateKeyHex(SEED, 0)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives the expected xpub for the standard test mnemonic', () => {
    expect(deriveAddress(deriveXpub(SEED), 0)).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')
  })

  it('rejects a negative or non-integer index', () => {
    expect(() => derivePrivateKeyHex(SEED, -1)).toThrow(RangeError)
    expect(() => derivePrivateKeyHex(SEED, 2.5)).toThrow(RangeError)
  })

  it('assertMatchesXpub passes for the matching xpub', () => {
    expect(() => assertMatchesXpub(SEED, deriveXpub(SEED))).not.toThrow()
  })

  it('assertMatchesXpub throws when seed and xpub disagree', () => {
    // The catastrophic misconfiguration: web hands out addresses from one wallet while the
    // signer holds a different seed, so swept funds and deposits diverge permanently.
    const otherSeed = mnemonicToSeedSync(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    )
    expect(() => assertMatchesXpub(otherSeed, deriveXpub(SEED))).toThrow(/does not match/i)
  })

  it('loadSignerSeed refuses to start without a mnemonic', () => {
    expect(() => loadSignerSeed({} as unknown as NodeJS.ProcessEnv)).toThrow(/TRON_MNEMONIC/)
  })

  it('loadSignerSeed accepts a valid mnemonic', () => {
    const seed = loadSignerSeed({ TRON_MNEMONIC: MNEMONIC } as unknown as NodeJS.ProcessEnv)
    expect(Buffer.from(seed).toString('hex')).toBe(Buffer.from(SEED).toString('hex'))
  })

  it('loadSignerSeed rejects an invalid mnemonic', () => {
    expect(() =>
      loadSignerSeed({
        TRON_MNEMONIC: 'not actually a valid bip39 phrase at all',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/mnemonic/i)
  })
})
