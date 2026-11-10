import type { ReceivedDocumentQuery } from './ports/received-document-query.port.js';
import {
  STORAGE_PRESIGN_DEFAULT_SECONDS,
  StorageObjectNotFoundError,
  type StorageProvider,
} from './ports/storage-provider.port.js';

export interface GetArtifactDeps {
  readonly query: ReceivedDocumentQuery;
  readonly storage: StorageProvider;
}

/** `not-found`: no such document for the tenant, no artifact attached, or the object is gone. */
export type ArtifactDownload =
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'found';
      readonly bytes: Uint8Array;
      readonly contentType: string;
      readonly originalName: string | null;
    };

export type ArtifactLink =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'found'; readonly url: string; readonly expiresInSeconds: number };

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** Resolves the stored bytes of a document's artifact; the storage key never leaves this layer. */
export function createGetArtifact({ query, storage }: GetArtifactDeps) {
  return async (tenantId: string, id: string): Promise<ArtifactDownload> => {
    const artifact = (await query.find(tenantId, id))?.artifact;
    if (!artifact) return { kind: 'not-found' };
    try {
      return {
        kind: 'found',
        bytes: await storage.download(artifact.storageKey),
        contentType: artifact.contentType ?? FALLBACK_CONTENT_TYPE,
        originalName: artifact.originalName,
      };
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return { kind: 'not-found' };
      throw error;
    }
  };
}

/** A time-limited direct download URL for the artifact (the integrator fetches it, not the API). */
export function createGetArtifactUrl({ query, storage }: GetArtifactDeps) {
  return async (tenantId: string, id: string): Promise<ArtifactLink> => {
    const artifact = (await query.find(tenantId, id))?.artifact;
    if (!artifact) return { kind: 'not-found' };
    const expiresInSeconds = STORAGE_PRESIGN_DEFAULT_SECONDS;
    return {
      kind: 'found',
      url: await storage.presignedUrl(artifact.storageKey, { expiresInSeconds }),
      expiresInSeconds,
    };
  };
}
