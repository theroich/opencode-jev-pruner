/** Case-insensitive glob matcher supporting `*` and `?`. */
export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "") return false
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "i")
  return regex.test(value)
}

export function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern))
}
