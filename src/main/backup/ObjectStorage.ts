import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** The three things a backup needs from cloud storage. Injected so tests can use a folder instead. */
export interface ObjectStorage {
  /** Uploads a local file under a key, encrypted with KMS (null = the account's default S3 key). */
  put(key: string, filePath: string, kmsKeyId: string | null): Promise<void>;
  /** Downloads the object at a key into a local file. */
  get(key: string, filePath: string): Promise<void>;
  /** Lists every key under a prefix. */
  list(prefix: string): Promise<string[]>;
}

/**
 * Object storage backed by an S3 bucket. Credentials come from a named profile in `~/.aws`, so no AWS
 * secret is stored by this app. Every upload is encrypted with KMS.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  /**
   * @param bucket The bucket name.
   * @param region The bucket's region.
   * @param profile The `~/.aws` profile whose credentials are used.
   */
  constructor(
    private readonly bucket: string,
    region: string,
    profile: string,
  ) {
    this.client = new S3Client({ region, profile });
  }

  /**
   * Uploads a file with server-side KMS encryption.
   * @param key The object key.
   * @param filePath The local file to upload.
   * @param kmsKeyId A customer-managed key id, or null for the account's default S3 KMS key.
   */
  async put(key: string, filePath: string, kmsKeyId: string | null): Promise<void> {
    // A Buffer rather than a stream: the SDK can resend a Buffer when it retries after a network blip,
    // and a stream is used up by the first try. The gzipped database is small enough to hold in memory.
    const body = await readFile(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: "application/gzip",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: kmsKeyId ?? undefined,
      }),
    );
  }

  /**
   * Downloads an object to a local file.
   * @param key The object key.
   * @param filePath Where to write it.
   */
  async get(key: string, filePath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) {
      throw new Error(`S3 returned no data for ${key}.`);
    }
    await pipeline(response.Body as Readable, createWriteStream(filePath));
  }

  /**
   * Lists every key under a prefix, following pagination.
   * @param prefix The key prefix.
   * @returns The keys.
   */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key) {
          keys.push(item.Key);
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }
}
