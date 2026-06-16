import { isAbsolute, relative } from "node:path";

function isParentTraversal(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\");
}

/**
 * Returns true if `target` is at or below `base` in the directory tree.
 */
export function isDescendantOf(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !isAbsolute(rel) && !isParentTraversal(rel);
}
