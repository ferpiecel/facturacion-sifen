/** A CSC failed format validation. Never carries the offending value. */
export class InvalidCscError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCscError';
  }
}

/** `idCSC` (4 digits) and the CSC itself (32 alphanumeric characters). */
export interface Csc {
  readonly idCsc: string;
  readonly value: string;
}

const ID_CSC = /^[0-9]{4}$/;
const CSC_VALUE = /^[A-Za-z0-9]{32}$/;

/** @throws InvalidCscError, without echoing the CSC, when either part is malformed. */
export function parseCsc(idCsc: string, value: string): Csc {
  if (!ID_CSC.test(idCsc)) {
    throw new InvalidCscError('idCSC must be exactly 4 digits');
  }
  if (!CSC_VALUE.test(value)) {
    throw new InvalidCscError('CSC must be exactly 32 alphanumeric characters');
  }
  return { idCsc, value };
}
