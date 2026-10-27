/** Hide record bookkeeping at presentation boundaries; never change the saved original. */
export function presentRecordPayload<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, '_sourcesHash'> {
  const visible = { ...payload };
  delete visible._sourcesHash;
  return visible;
}
