import { execFile } from "node:child_process";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

/** Haiku 4.5 on Amazon Bedrock, through the US cross-region inference profile. */
export const BEDROCK_HAIKU_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/** Sonnet 5.5 on Amazon Bedrock, for questions about calls (probed 2026-11-09: answers on this account). */
export const BEDROCK_SONNET_MODEL = "us.anthropic.claude-sonnet-5-5";

/** Used when the shell sets no AWS_REGION. */
const DEFAULT_REGION = "us-east-1";

/** Starts the line the shell prints the keys on, so the shell's own start-up noise is skipped. */
const KEYS_MARKER = "__TIME_CENTER_AWS__";

/** How long the shell may take to start before the keys are given up on. */
const SHELL_TIMEOUT_MS = 10_000;

/** AWS keys, as your shell sets them. */
export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
  region: string | null;
}

/** Sends one Messages API request to Haiku; the seam MeetingTyper is tested through. */
export interface HaikuClient {
  /**
   * @param body A Messages API body without `model` (Bedrock picks the model from the call).
   * @returns Haiku's reply.
   */
  invoke(body: object): Promise<unknown>;
  /** @returns Where the AWS keys came from, once a call has looked; null before. */
  describe(): string | null;
}

/**
 * Calls Claude on Amazon Bedrock (Haiku unless told otherwise) with the AWS keys your `~/.bashrc` exports. The app is opened from
 * Finder, so it never runs `.bashrc` itself: the first call asks your shell for the keys, once. Without
 * them it falls back to the AWS SDK's usual places (`~/.aws`).
 */
export class BedrockHaiku implements HaikuClient {
  private client: Promise<BedrockRuntimeClient> | null = null;
  private source: string | null = null;

  /**
   * @param readKeys Reads the keys; your shell's by default, injected for tests.
   * @param modelId The Bedrock model to call: Haiku by default, Sonnet for questions about calls.
   */
  constructor(
    private readonly readKeys: () => Promise<AwsKeys | null> = readShellAwsKeys,
    private readonly modelId: string = BEDROCK_HAIKU_MODEL,
  ) {}

  /**
   * Sends a request and returns the parsed reply.
   * @param body The Messages API body.
   * @returns The reply.
   */
  async invoke(body: object): Promise<unknown> {
    const client = await (this.client ??= this.createClient());
    try {
      const response = await client.send(
        new InvokeModelCommand({
          modelId: this.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(body),
        }),
      );
      return JSON.parse(new TextDecoder().decode(response.body));
    } catch (error) {
      throw new Error(`Bedrock said: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** @returns Where the keys came from, for Settings. */
  describe(): string | null {
    return this.source;
  }

  /**
   * Builds the Bedrock client from your shell's keys, or from the SDK's defaults without them.
   * @returns The client.
   */
  private async createClient(): Promise<BedrockRuntimeClient> {
    const keys = await this.readKeys().catch(() => null);
    if (!keys) {
      this.source = `the default AWS profile (${DEFAULT_REGION})`;
      return new BedrockRuntimeClient({ region: DEFAULT_REGION });
    }
    const region = keys.region ?? DEFAULT_REGION;
    this.source = `your AWS keys from ~/.bashrc (${region})`;
    return new BedrockRuntimeClient({
      region,
      credentials: {
        accessKeyId: keys.accessKeyId,
        secretAccessKey: keys.secretAccessKey,
        ...(keys.sessionToken ? { sessionToken: keys.sessionToken } : {}),
      },
    });
  }
}

/**
 * Asks an interactive bash (which reads `~/.bashrc`) for the AWS variables. The values go straight into
 * memory; they are never logged or stored.
 * @returns The keys, or null when the shell doesn't set both halves.
 */
export function readShellAwsKeys(): Promise<AwsKeys | null> {
  const script =
    `printf '\\n${KEYS_MARKER}%s\\037%s\\037%s\\037%s\\n' ` +
    `"$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" "\${AWS_REGION:-$AWS_DEFAULT_REGION}"`;
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-ic", script], { timeout: SHELL_TIMEOUT_MS }, (_error, stdout) => {
      resolve(parseShellKeys(String(stdout ?? "")));
    });
  });
}

/**
 * Reads the keys line out of the shell's output.
 * @param output Everything the shell printed.
 * @returns The keys, or null when the line is missing or a half is empty.
 */
export function parseShellKeys(output: string): AwsKeys | null {
  const line = output.split("\n").find((text) => text.startsWith(KEYS_MARKER));
  if (!line) {
    return null;
  }
  const [accessKeyId, secretAccessKey, sessionToken, region] = line.slice(KEYS_MARKER.length).split("\x1f");
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return { accessKeyId, secretAccessKey, sessionToken: sessionToken || null, region: region?.trim() || null };
}
