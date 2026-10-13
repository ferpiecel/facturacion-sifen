/** The allowlist of Markdown guides, fixed when the application starts. */
export interface GuideCatalog {
  /** Sorted posix paths relative to the docs root. */
  paths(): string[];
  /** Source of an allowlisted path; `undefined` for anything else. Never touches other files. */
  read(path: string): string | undefined;
}
