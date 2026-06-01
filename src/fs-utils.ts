import { stat } from "node:fs/promises";

/** Check if a resolved path is a directory via stat. Returns false on any error. */
export async function isDirectory(resolvedPath: string): Promise<boolean> {
  try {
    const s = await stat(resolvedPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}
