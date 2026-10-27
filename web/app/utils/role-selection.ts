/** Add or invert only the current result set, preserving selections outside it. */
export function selectRoleResults(
  selected: string[],
  resultIds: string[],
  invert = false,
): string[] {
  const next = new Set(selected);
  for (const id of new Set(resultIds)) {
    if (invert && next.has(id)) next.delete(id);
    else next.add(id);
  }
  return [...next];
}
