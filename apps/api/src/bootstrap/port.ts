const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

export function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (value.trim() === '' || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`Invalid PORT value: ${JSON.stringify(value)}`);
  }

  return port;
}
