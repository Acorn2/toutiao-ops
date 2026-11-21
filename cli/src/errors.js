export class OperationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function fail(code, message) {
  throw new OperationError(code, message);
}

export function errorCode(error) {
  if (error?.code && /^[A-Z][A-Z0-9_]+$/.test(error.code)) return error.code;
  if (/closed|Target.*page/i.test(error?.message || '')) return 'BROWSER_CLOSED';
  if (error?.name === 'TimeoutError') return 'PAGE_TIMEOUT';
  return 'OPERATION_FAILED';
}
