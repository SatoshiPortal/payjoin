export function isStubMode() {
  return process.env.STUB_MODE && process.env.STUB_MODE.toLowerCase() === "true";
}

export function isProviderStubMode() {
  return process.env.PROVIDER_STUB_MODE && process.env.PROVIDER_STUB_MODE.toLowerCase() === "true";
}
