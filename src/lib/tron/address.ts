import { HDKey } from '@scure/bip32'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { TronWeb, utils as tronUtils } from 'tronweb'

/** BIP44 account-level node for Tron. The exported xpub is this node's public key. */
export const ACCOUNT_PATH = "m/44'/195'/0'/0"

const HEX_40 = /^[0-9a-f]{40}$/i

/**
 * Derive the deposit address for `index` from a watch-only xpub.
 *
 * `@scure/bip32` returns a 33-byte COMPRESSED public key; TronWeb's `computeAddress`
 * requires the 65-byte uncompressed form. Feeding it the compressed key yields a
 * well-formed but wrong address, and funds sent there are unrecoverable — so the
 * decompression below is load-bearing, not a formality.
 */
export function deriveAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`derivation index must be a non-negative integer, got ${index}`)
  }

  const node = HDKey.fromExtendedKey(xpub)
  if (node.privateKey) {
    throw new Error('expected a watch-only xpub; this key carries private material')
  }

  const compressed = node.deriveChild(index).publicKey
  if (!compressed) throw new Error(`could not derive public key at index ${index}`)

  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false)
  return tronUtils.crypto.getBase58CheckAddress(tronUtils.crypto.computeAddress(uncompressed))
}

/**
 * Convert a hex address to base58check. TronGrid event results use a bare 20-byte hex
 * form with an `0x` prefix and no Tron `41` version byte.
 */
export function hexToTronAddress(hex: string): string {
  let body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (body.length === 42 && body.toLowerCase().startsWith('41')) body = body.slice(2)
  if (!HEX_40.test(body)) throw new RangeError(`not a 20-byte hex address: ${hex}`)

  const bytes = Buffer.from(`41${body}`, 'hex')
  return tronUtils.crypto.getBase58CheckAddress(Array.from(bytes))
}

export function isTronAddress(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && TronWeb.isAddress(value)
}
