import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultDebug,
  defaultResilience,
  defaultSelector,
  defaultSession,
  defaultTriggers,
} from '../../test/fixtures/bootstrap-json.js'
import { createFixtureMcpServer } from './fake-mcp.js'

export async function createSmokeFixture() {
  const gmail = await createFixtureMcpServer([
    { name: 'list_emails', description: 'List inbox emails and threads' },
    { name: 'search_emails', description: 'Search email messages by query and sender' },
    { name: 'send_email', description: 'Send an email message to recipients' },
  ])

  const docs = await createFixtureMcpServer([
    { name: 'docs_search', description: 'Search the internal docs knowledge base' },
    { name: 'docs_read', description: 'Read one documentation page by id' },
  ])

  const github = await createFixtureMcpServer([
    { name: 'list_issues', description: 'List GitHub issues for a repository' },
    { name: 'create_issue', description: 'Create a GitHub issue in a repository' },
  ])

  const configDir = mkdtempSync(join(tmpdir(), 'mcp-gateway-bench-'))
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'bootstrap.json'),
    JSON.stringify(
      {
        servers: [
          {
            id: 'gmail-server',
            namespaces: ['work', 'work-code'],
            transport: 'streamable-http',
            url: gmail.url,
            enabled: true,
            trustLevel: 'internal',
          },
          {
            id: 'docs-server',
            namespaces: ['work', 'work-code'],
            transport: 'streamable-http',
            url: docs.url,
            enabled: true,
            trustLevel: 'internal',
          },
          {
            id: 'github-server',
            namespaces: ['work', 'work-code'],
            transport: 'streamable-http',
            url: github.url,
            enabled: true,
            trustLevel: 'internal',
          },
        ],
        auth: { mode: 'static_key' },
        namespaces: {
          work: {
            allowedRoles: ['user', 'admin'],
            bootstrapWindowSize: 3,
            candidatePoolSize: 12,
            allowedModes: ['read', 'write'],
          },
          'work-code': {
            allowedRoles: ['user', 'admin'],
            bootstrapWindowSize: 3,
            candidatePoolSize: 12,
            allowedModes: ['read', 'write'],
            gatewayMode: 'code',
          },
        },
        roles: {
          user: {
            allowNamespaces: ['work', 'work-code'],
            denyModes: ['admin'],
          },
          admin: {
            allowNamespaces: ['work', 'work-code'],
          },
        },
        selector: defaultSelector,
        session: defaultSession,
        triggers: defaultTriggers,
        resilience: defaultResilience,
        debug: {
          ...defaultDebug,
          enabled: true,
        },
        starterPacks: {
          work: {
            preferredTags: ['email', 'docs', 'github'],
            maxTools: 4,
            includeRiskLevels: ['low', 'medium'],
            includeModes: ['read', 'write'],
          },
          'work-code': {
            preferredTags: ['email', 'docs', 'github'],
            maxTools: 4,
            includeRiskLevels: ['low', 'medium'],
            includeModes: ['read', 'write'],
          },
        },
      },
      null,
      2
    )
  )

  return {
    configDir,
    authHeader: 'Bearer benchmark:user',
    async close() {
      await Promise.all([gmail.close(), docs.close(), github.close()])
      rmSync(configDir, { recursive: true, force: true })
    },
  }
}
