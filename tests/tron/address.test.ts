import { describe, it, expect } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { TronWeb } from 'tronweb'
import { deriveAddress, hexToTronAddress, isTronAddress, ACCOUNT_PATH } from '@/lib/tron/address'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function testXpub(): string {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
    .publicExtendedKey
}

describe('deriveAddress', () => {
  it('matches known vectors for the standard test mnemonic', () => {
    const xpub = testXpub()
    expect(deriveAddress(xpub, 0)).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')
    expect(deriveAddress(xpub, 1)).toBe('TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK')
    expect(deriveAddress(xpub, 5)).toBe('TBdYXtwq18cAhi1BA574TrP6tw2G86anu1')
    expect(deriveAddress(xpub, 42)).toBe('TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb')
  })

  it('agrees with private-key derivation at every index', () => {
    // The guarantee that matters: an address derived from the watch-only xpub must be
    // spendable by the key the signer derives for the same index.
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const xpub = master.derive(ACCOUNT_PATH).publicExtendedKey

    for (let i = 0; i < 20; i++) {
      const priv = master.derive(`${ACCOUNT_PATH}/${i}`).privateKey!
      const fromPrivate = TronWeb.address.fromPrivateKey(Buffer.from(priv).toString('hex'))
      expect(deriveAddress(xpub, i)).toBe(fromPrivate)
    }
  })

  it('is deterministic', () => {
    const xpub = testXpub()
    expect(deriveAddress(xpub, 7)).toBe(deriveAddress(xpub, 7))
  })

  it('produces a distinct address per index', () => {
    const xpub = testXpub()
    const seen = new Set(Array.from({ length: 50 }, (_, i) => deriveAddress(xpub, i)))
    expect(seen.size).toBe(50)
  })

  it('rejects a negative or non-integer index', () => {
    const xpub = testXpub()
    expect(() => deriveAddress(xpub, -1)).toThrow(RangeError)
    expect(() => deriveAddress(xpub, 1.5)).toThrow(RangeError)
  })

  it('refuses an extended key that carries a private key', () => {
    // Passing an xprv here would mean the web process was handed spending material.
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
      .privateExtendedKey
    expect(() => deriveAddress(xprv, 0)).toThrow(/xpub/i)
  })
})

describe('hexToTronAddress', () => {
  it('converts the 0x-prefixed form TronGrid events return', () => {
    // from the probed Transfer event
    expect(hexToTronAddress('0x82dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(
      'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
    )
  })

  it('accepts the 41-prefixed and bare forms too', () => {
    expect(hexToTronAddress('4182dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(
      'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
    )
    expect(hexToTronAddress('82dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(
      'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
    )
  })

  it('rejects malformed hex', () => {
    expect(() => hexToTronAddress('0x1234')).toThrow(RangeError)
    expect(() => hexToTronAddress('zzzz')).toThrow(RangeError)
  })
})

describe('isTronAddress', () => {
  it('accepts real addresses and rejects junk', () => {
    expect(isTronAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')).toBe(true)
    expect(isTronAddress('0x82dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(false)
    expect(isTronAddress('not-an-address')).toBe(false)
    expect(isTronAddress('')).toBe(false)
  })
})
