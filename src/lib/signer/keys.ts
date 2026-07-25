import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { ACCOUNT_PATH, deriveAddress } from '@/lib/tron/address'

/**
 * SIGNER PROCESS ONLY.
 *
 * Nothing in this file may be imported by `web` or `worker`. It is the single point at
 * which spending material enters the system.
 */
export function loadSignerSeed(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const mnemonic = env.TRON_MNEMONIC?.trim()
  if (!mnemonic) throw new Error('TRON_MNEMONIC is not set; the signer cannot start')
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('TRON_MNEMONIC is not a valid BIP39 mnemonic')
  }
  return mnemonicToSeedSync(mnemonic)
}

export function deriveXpub(seed: Uint8Array): string {
  return HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH).publicExtendedKey
}

export function derivePrivateKeyHex(seed: Uint8Array, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`derivation index must be a non-negative integer, got ${index}`)
  }
  const key = HDKey.fromMasterSeed(seed).derive(`${ACCOUNT_PATH}/${index}`).privateKey
  if (!key) throw new Error(`could not derive private key at index ${index}`)
  return Buffer.from(key).toString('hex')
}

/**
 * Fail fast on the catastrophic misconfiguration: if the signer's seed does not correspond
 * to the xpub the web app hands out, deposits go to addresses this signer cannot spend and
 * sweeps move funds nobody expected. Checked at signer startup.
 */
export function assertMatchesXpub(seed: Uint8Array, xpub: string, index = 0): void {
  const fromSeed = deriveAddress(deriveXpub(seed), index)
  const fromXpub = deriveAddress(xpub, index)
  if (fromSeed !== fromXpub) {
    throw new Error(
      `signer seed does not match TRON_XPUB: index ${index} derives ${fromSeed} from the seed ` +
        `but ${fromXpub} from the xpub`,
    )
  }
}
