/**
 * Pi reports installs to its maintainers and tags provider requests as its own unless told not
 * to. Veistra's harness does neither, so this is set before Pi is first imported.
 */
export function quietPi(env: NodeJS.ProcessEnv = process.env): void {
  env.PI_TELEMETRY = "0";
  env.PI_SKIP_VERSION_CHECK = "1";
}

/**
 * Pi needs Node 22.19 or newer. Checked before anything imports Pi, so an older Node gets a
 * sentence rather than a syntax error from somewhere inside it.
 */
export function checkNode(version = process.versions.node): string | null {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19)
    ? null
    : `Veistra's agent needs Node.js 22.19 or newer; this is ${version}.`;
}
