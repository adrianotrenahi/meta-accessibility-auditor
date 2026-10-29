/** A small, address-free description for future connection investigations.
 * This is saved evidence only, never permission to retry or release a charge.
 */
export type MetaOperation = 'connect' | 'read' | 'write' | 'lookup' | 'unknown';
export type MetaOperationEvidence = {
  causeOperations: { code: string; operation: MetaOperation }[];
  causeOperationsIncomplete?: true;
};

export function metaOperationEvidence(
  error: unknown,
  knownCodes: ReadonlySet<string>,
): MetaOperationEvidence {
  const causeOperations: MetaOperationEvidence['causeOperations'] = [];
  const seen = new Set<object>();
  let remaining = 32;
  let incomplete = false;
  const value = (object: object, key: string): unknown => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && !('value' in descriptor)) incomplete = true;
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
      incomplete = true;
      return undefined;
    }
  };
  const add = (code: unknown, syscall: unknown) => {
    const operation: MetaOperation =
      syscall === 'connect' || syscall === 'read' || syscall === 'write'
        ? syscall
        : syscall === 'getaddrinfo'
          ? 'lookup'
          : 'unknown';
    const safeCode = typeof code === 'string' && knownCodes.has(code) ? code : 'OTHER';
    if (causeOperations.some((item) => item.code === safeCode && item.operation === operation))
      return;
    if (causeOperations.length < 16) causeOperations.push({ code: safeCode, operation });
    else incomplete = true;
  };
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== 'object' || depth > 4 || --remaining < 0 || seen.has(item)) {
      incomplete = true;
      return;
    }
    seen.add(item);
    const code = value(item, 'code');
    const syscall = value(item, 'syscall');
    const cause = value(item, 'cause');
    const errors = value(item, 'errors');
    if (
      code !== undefined ||
      syscall !== undefined ||
      (cause === undefined && errors === undefined)
    )
      add(code, syscall);
    if (cause !== undefined) visit(cause, depth + 1);
    if (errors !== undefined) {
      const length = typeof errors === 'object' && errors ? value(errors, 'length') : undefined;
      if (
        !Array.isArray(errors) ||
        !Number.isInteger(length) ||
        Number(length) < 1 ||
        Number(length) > 8
      )
        incomplete = true;
      else for (let i = 0; i < Number(length); i++) visit(value(errors, String(i)), depth + 1);
    }
  };
  try {
    visit(error, 0);
  } catch {
    // Even a hostile/revoked object must not replace the real request failure.
    incomplete = true;
  }
  return {
    causeOperations,
    ...(incomplete ? { causeOperationsIncomplete: true } : {}),
  };
}
