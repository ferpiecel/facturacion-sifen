import type { Failure } from './auth-client';

/** User-facing text of a failed auth attempt. The API never says which credential was wrong; neither do we. */
export function failureMessage(failure: Failure, invalid: string): string {
  switch (failure.kind) {
    case 'throttled':
      return 'Demasiados intentos. Esperá unos minutos antes de volver a intentarlo.';
    case 'unavailable':
      return 'No pudimos conectar con el servidor. Intentá de nuevo en unos instantes.';
    case 'invalid':
      return invalid;
  }
}
