export type DownstreamCredentialKind = 'bearer' | 'oauth_tokens' | 'oauth_client_secret'

export interface StoredDownstreamCredential {
  serverId: string
  kind: DownstreamCredentialKind
  ciphertext: string
  iv: string
  tag: string
  metaJson?: string
  updatedAt: number
}

export interface IDownstreamAuthRepository {
  get(serverId: string, kind: DownstreamCredentialKind): Promise<StoredDownstreamCredential | undefined>
  save(input: StoredDownstreamCredential): Promise<void>
  delete(serverId: string, kind?: DownstreamCredentialKind): Promise<void>
  listByServer(serverId: string): Promise<StoredDownstreamCredential[]>
}
