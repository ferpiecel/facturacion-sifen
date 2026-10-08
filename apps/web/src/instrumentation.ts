/** Runs once when the Next server starts. The Node part pins the client address (see `security/client-address.ts`). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    registerNode();
  }
}
