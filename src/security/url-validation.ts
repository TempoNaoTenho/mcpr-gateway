import { lookup } from 'node:dns/promises'

// Private IP ranges per RFC standards
const PRIVATE_IPV4_RANGES = [
  { start: ipToNumber('10.0.0.0'), end: ipToNumber('10.255.255.255') }, // 10.0.0.0/8
  { start: ipToNumber('172.16.0.0'), end: ipToNumber('172.31.255.255') }, // 172.16.0.0/12
  { start: ipToNumber('192.168.0.0'), end: ipToNumber('192.168.255.255') }, // 192.168.0.0/16
  { start: ipToNumber('127.0.0.0'), end: ipToNumber('127.255.255.255') }, // 127.0.0.0/8 (localhost)
]

const PRIVATE_IPV6_PREFIXES = [
  '::1', // Loopback
  'fc00:', // fc00::/7 (unique local)
  'fe80:', // fe80::/10 (link-local)
  '::ffff:0:0', // ::ffff:0:0/96 (IPv4-mapped IPv6)
]

/**
 * Convert IPv4 address string to number for range comparison
 */
function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number)
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

/**
 * Convert IPv4-mapped IPv6 address (::ffff:x.x.x.x) to number
 */
function ipv6ToNumber(ipv6: string): number | null {
  // Handle IPv4-mapped IPv6 addresses like ::ffff:192.168.1.1
  const match = ipv6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (match) {
    return ipToNumber(match[1])
  }
  return null
}

/**
 * Check if an IPv4 address is in a private range
 */
function isPrivateIPv4(ip: string): boolean {
  const num = ipToNumber(ip)
  return PRIVATE_IPV4_RANGES.some((range) => num >= range.start && num <= range.end)
}

/**
 * Check if an IPv6 address is in a private range
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  return PRIVATE_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * Check if URL's hostname resolves to localhost
 */
export function isLocalhost(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0'
    )
  } catch {
    return false
  }
}

/**
 * Check if URL's hostname resolves to a private IP address (SSRF protection)
 * Resolves DNS to catch DNS rebinding attacks
 */
export async function isPrivateIp(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname

    // First check the hostname directly (before DNS resolution)
    // This catches literal private IPs in the URL
    if (isPrivateIPv4(hostname)) return true
    if (isPrivateIPv6(hostname)) return true

    // Resolve hostname to IP and check all results
    // We always resolve fresh (no caching) to prevent DNS rebinding attacks
    const records = await lookup(hostname, { all: true })

    for (const entry of records) {
      if (entry.family === 4) {
        if (isPrivateIPv4(entry.address)) return true
      } else if (entry.family === 6) {
        if (isPrivateIPv6(entry.address)) return true
        // Also check IPv4-mapped IPv6 addresses
        const asV4 = ipv6ToNumber(entry.address)
        if (asV4 !== null && isPrivateIPv4(entry.address)) return true
      }
    }

    return false
  } catch {
    // If DNS resolution fails, we can't verify - treat as potentially unsafe
    return true
  }
}

/**
 * Check if OAuth URL is allowed based on allowlist and security checks
 * - Rejects non-HTTPS URLs
 * - If allowlist is empty, allows HTTPS URLs passing private IP/localhost checks
 * - If allowlist has entries, URL must match one of the patterns
 */
export async function isAllowedOAuthUrl(url: string, allowlist: string[]): Promise<boolean> {
  try {
    const parsed = new URL(url)

    // Always reject non-HTTPS URLs
    if (parsed.protocol !== 'https:') {
      return false
    }

    // If allowlist is configured, enforce it
    if (allowlist.length > 0) {
      const urlOrigin = parsed.origin
      return allowlist.some((pattern) => {
        // Support wildcard patterns like *.example.com
        if (pattern.startsWith('*.')) {
          const domain = pattern.slice(2)
          return urlOrigin === `https://${domain}` || urlOrigin.endsWith(`.${domain}`)
        }
        return urlOrigin === new URL(pattern).origin
      })
    }

    // No allowlist - check that URL is safe (not localhost/private IP)
    if (isLocalhost(url)) return false
    if (await isPrivateIp(url)) return false

    return true
  } catch {
    return false
  }
}
