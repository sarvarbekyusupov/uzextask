export function isCement(value: string): boolean {
  return /^(?:sement(?:ni|ning|dan|ga)?|цемент(?:а|у|ом|е)?)$/iu.test(value.trim());
}
