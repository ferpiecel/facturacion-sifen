export interface SecretVerifier {
  verify(secret: string, hash: string): Promise<boolean>;
}
