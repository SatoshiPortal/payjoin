export function isStubMode() {
  return process.env.STUB_MODE?.toLowerCase() === "true";
}
