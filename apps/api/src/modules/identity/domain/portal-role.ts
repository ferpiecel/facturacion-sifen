/** Roles of a portal user inside one tenant (PRD A4); mirrors the `portal_role` enum. */
export const PORTAL_ROLES = ['owner', 'admin', 'emisor', 'lector'] as const;

export type PortalRole = (typeof PORTAL_ROLES)[number];

export function isPortalRole(value: string): value is PortalRole {
  return (PORTAL_ROLES as readonly string[]).includes(value);
}
