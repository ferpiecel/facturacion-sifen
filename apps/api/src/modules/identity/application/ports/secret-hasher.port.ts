/** Hashes a newly minted secret before it is persisted (backlog HU-E1-05). */
export interface SecretHasher {
  hash(secret: string): Promise<string>;
}
