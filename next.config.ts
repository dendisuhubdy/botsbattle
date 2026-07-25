import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['pg', '@node-rs/argon2'],
}

export default nextConfig
