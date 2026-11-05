/**
 * Local code signing for Time Center, so macOS keeps its permissions across rebuilds.
 *
 * macOS ties each permission (Accessibility, Screen Recording, Microphone, …) to the app's signature. An
 * ad-hoc signature changes on every build, so every rebuild was asked again. Signing with one fixed
 * certificate gives every build the same identity.
 *
 * The certificate is self-signed and trusted by nobody but this Mac, which is all it needs. It lives in
 * its own keychain (`~/Library/Keychains/time-center-signing.keychain-db`) so signing never prompts for
 * the login password. That keychain's random password is kept in the login keychain, never in a file.
 *
 *   node scripts/signing.ts setup          creates the certificate once (does nothing if it exists)
 *   node scripts/signing.ts sign <app>     signs a built .app with it
 *
 * When the login keychain holds an "Apple Development" certificate, `sign` uses that instead (see
 * findAppleDevelopmentIdentity).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The certificate's name, as codesign and Keychain Access show it. */
const CERT_NAME = "Time Center Local Signing";

/** The keychain that holds only this certificate and its private key. */
const KEYCHAIN_PATH = join(homedir(), "Library", "Keychains", "time-center-signing.keychain-db");

/** Where the keychain's password is kept in the login keychain. */
const PASSWORD_ITEM = { service: "time-center-signing-keychain", account: "time-center" };

/** How long the certificate lasts. */
const VALID_DAYS = 3650;

main();

/**
 * Runs the subcommand named on the command line.
 */
function main(): void {
  const [command, appPath] = process.argv.slice(2);
  if (command === "setup") {
    setup();
    return;
  }
  if (command === "sign" && appPath) {
    sign(appPath);
    return;
  }
  console.error("Usage: node scripts/signing.ts setup | sign <path-to.app>");
  process.exitCode = 1;
}

/**
 * Creates the signing keychain and certificate, unless they already exist.
 */
function setup(): void {
  if (existsSync(KEYCHAIN_PATH) && findIdentityHash()) {
    console.log(`Signing certificate "${CERT_NAME}" already exists.`);
    return;
  }
  if (existsSync(KEYCHAIN_PATH)) {
    throw new Error(`${KEYCHAIN_PATH} exists but holds no "${CERT_NAME}" identity. Delete it in Keychain Access, then run setup again.`);
  }
  const password = randomBytes(24).toString("base64url");
  const workDir = mkdtempSync(join(tmpdir(), "time-center-signing-"));
  try {
    const bundlePath = createCertificate(workDir, password);
    createKeychain(password);
    security("import", bundlePath, "-k", KEYCHAIN_PATH, "-f", "pkcs12", "-P", password, "-T", "/usr/bin/codesign");
    // Lets codesign use the private key without a "codesign wants to use your keychain" prompt.
    security("set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, KEYCHAIN_PATH);
    security(
      "add-generic-password",
      "-U",
      "-s",
      PASSWORD_ITEM.service,
      "-a",
      PASSWORD_ITEM.account,
      "-w",
      password,
      join(homedir(), "Library", "Keychains", "login.keychain-db"),
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const hash = findIdentityHash();
  if (!hash) {
    throw new Error("The certificate was imported but codesign can't see it as a signing identity.");
  }
  console.log(`Created signing certificate "${CERT_NAME}" (${hash}).`);
}

/**
 * Signs a built app with the local certificate, replacing electron-builder's ad-hoc signature.
 * @param appPath The .app bundle.
 */
function sign(appPath: string): void {
  const identity = findAppleDevelopmentIdentity() ?? localIdentity();
  // --deep covers nested bundles only, not loose executables in Resources, so sign our helper first.
  const helper = join(appPath, "Contents/Resources/bin/active-window");
  if (existsSync(helper)) {
    execFileSync("codesign", ["--force", "--sign", identity.hash, ...identity.keychainArgs, helper], { stdio: "inherit" });
  }
  // --deep signs the Electron frameworks and helper apps inside the bundle with the same identity.
  execFileSync("codesign", ["--force", "--deep", "--sign", identity.hash, ...identity.keychainArgs, appPath], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log(`Signed ${appPath} with "${identity.name}".`);
}

/**
 * Finds an "Apple Development" certificate (from signing in to Xcode with an Apple ID) in the login
 * keychain. It is preferred because it carries a team ID: without one, the keychain trusts only the exact
 * build that clicked "Always Allow" (its partition list gains a `cdhash:` per build), so every rebuild asked
 * for the "Time Center Safe Storage" key again. Seen 2026-11-05: six `cdhash:` entries on that item.
 * @returns The identity, or null when there is none.
 */
function findAppleDevelopmentIdentity(): { hash: string; name: string; keychainArgs: string[] } | null {
  const output = security("find-identity", "-v", "-p", "codesigning");
  const match = output.match(/\b([0-9A-F]{40})\s+"(Apple Development: [^"]+)"/);
  if (!match) {
    return null;
  }
  return { hash: match[1], name: match[2], keychainArgs: [] };
}

/**
 * Unlocks the local signing keychain and returns its self-signed identity.
 * @returns The identity.
 */
function localIdentity(): { hash: string; name: string; keychainArgs: string[] } {
  if (!existsSync(KEYCHAIN_PATH)) {
    throw new Error("No signing certificate yet. Run `node scripts/signing.ts setup` once.");
  }
  unlockKeychain();
  const hash = findIdentityHash();
  if (!hash) {
    throw new Error(`The signing keychain holds no "${CERT_NAME}" identity.`);
  }
  return { hash, name: CERT_NAME, keychainArgs: ["--keychain", KEYCHAIN_PATH] };
}

/**
 * Writes a private key and a self-signed certificate allowed for code signing, bundled as PKCS#12.
 * The bundle uses SHA-1/3DES because macOS's keychain import can't read OpenSSL's newer defaults
 * (it rejected OpenSSL 4's PEM private key with "Unknown format in import").
 * @param workDir A scratch folder the caller deletes.
 * @param password Protects the bundle until it's imported.
 * @returns The bundle's path.
 */
function createCertificate(workDir: string, password: string): string {
  const configPath = join(workDir, "cert.cnf");
  const keyPath = join(workDir, "key.pem");
  const certPath = join(workDir, "cert.pem");
  writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      `CN = ${CERT_NAME}`,
      "[ext]",
      "basicConstraints = critical, CA:false",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = critical, codeSigning",
      "",
    ].join("\n"),
  );
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    String(VALID_DAYS),
    "-config",
    configPath,
  ], { stdio: "pipe" });
  const bundlePath = join(workDir, "identity.p12");
  execFileSync(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-inkey",
      keyPath,
      "-in",
      certPath,
      "-out",
      bundlePath,
      "-name",
      CERT_NAME,
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-macalg",
      "sha1",
      "-passout",
      "env:TIME_CENTER_P12_PASSWORD",
    ],
    { stdio: "pipe", env: { ...process.env, TIME_CENTER_P12_PASSWORD: password } },
  );
  return bundlePath;
}

/**
 * Creates the signing keychain, adds it to the search list so codesign finds it, and stops it locking
 * itself after a few minutes.
 * @param password The keychain's password.
 */
function createKeychain(password: string): void {
  security("create-keychain", "-p", password, KEYCHAIN_PATH);
  security("set-keychain-settings", KEYCHAIN_PATH);
  security("unlock-keychain", "-p", password, KEYCHAIN_PATH);
  const current = security("list-keychains", "-d", "user")
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (!current.includes(KEYCHAIN_PATH)) {
    security("list-keychains", "-d", "user", "-s", ...current, KEYCHAIN_PATH);
  }
}

/**
 * Unlocks the signing keychain with the password kept in the login keychain.
 */
function unlockKeychain(): void {
  const password = security("find-generic-password", "-s", PASSWORD_ITEM.service, "-a", PASSWORD_ITEM.account, "-w").trim();
  security("unlock-keychain", "-p", password, KEYCHAIN_PATH);
}

/**
 * Finds the certificate's SHA-1 hash in the signing keychain. The certificate isn't trusted system-wide,
 * so this looks at every identity, not only the "valid" ones.
 * @returns The hash, or null when the identity isn't there.
 */
function findIdentityHash(): string | null {
  const output = security("find-identity", "-p", "codesigning", KEYCHAIN_PATH);
  const line = output.split("\n").find((entry) => entry.includes(`"${CERT_NAME}"`));
  return line?.match(/\b([0-9A-F]{40})\b/)?.[1] ?? null;
}

/**
 * Runs the macOS `security` tool. Its output is returned, never printed, because some calls read a
 * password; a failure names only the subcommand, since the arguments can hold the keychain password.
 * @param args The arguments.
 * @returns What it printed.
 */
function security(...args: string[]): string {
  try {
    return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim() ?? "";
    throw new Error(`security ${args[0]} failed: ${stderr}`);
  }
}
