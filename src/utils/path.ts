export function sep(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}
