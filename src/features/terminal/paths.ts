/** Dropped file paths as one paste: each in double quotes, a space after each. */
export function quotePaths(paths: string[]): string {
  return paths.map((p) => `"${p}" `).join("");
}
