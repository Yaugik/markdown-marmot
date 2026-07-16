import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env, objectStorageConfigured } from "@/lib/env";
import { newFolioId } from "@/lib/folio-ids";

export type PutObjectInput = {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
};

export interface ObjectStore {
  readonly driver: "filesystem" | "s3";
  put(input: PutObjectInput): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class ObjectStoreError extends Error {
  constructor(
    public readonly code: "OBJECT_STORAGE_NOT_CONFIGURED" | "OBJECT_STORAGE_REQUEST_FAILED" | "OBJECT_STORAGE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

function normalizedKey(value: string): string {
  const key = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!key || key.length > 1500 || key.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ObjectStoreError("OBJECT_STORAGE_REQUEST_FAILED", "Object storage key is invalid.");
  }
  return key;
}

class FilesystemObjectStore implements ObjectStore {
  readonly driver = "filesystem" as const;

  private objectPath(key: string) {
    return path.join(process.cwd(), env.OBJECT_STORAGE_ROOT, ...normalizedKey(key).split("/"));
  }

  async put(input: PutObjectInput): Promise<void> {
    if (env.NODE_ENV === "production") {
      throw new ObjectStoreError("OBJECT_STORAGE_NOT_CONFIGURED", "Production deployments require S3-compatible object storage.");
    }
    const destination = this.objectPath(input.key);
    const temporary = `${destination}.${newFolioId()}.tmp`;
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.objectPath(key));
    } catch {
      throw new ObjectStoreError("OBJECT_STORAGE_NOT_FOUND", "Object content was not found.");
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true });
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsTimestamp(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodePath(value: string) {
  return value.split("/").map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

class S3ObjectStore implements ObjectStore {
  readonly driver = "s3" as const;

  private config() {
    if (!objectStorageConfigured() || !env.S3_ENDPOINT || !env.S3_REGION || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new ObjectStoreError("OBJECT_STORAGE_NOT_CONFIGURED", "S3-compatible object storage is not fully configured.");
    }
    return {
      endpoint: new URL(env.S3_ENDPOINT),
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      sessionToken: env.S3_SESSION_TOKEN,
    };
  }

  private requestTarget(key: string) {
    const config = this.config();
    const prefixed = normalizedKey([env.S3_KEY_PREFIX.replace(/^\/+|\/+$/g, ""), normalizedKey(key)].filter(Boolean).join("/"));
    const endpoint = new URL(config.endpoint.toString());
    if (env.S3_FORCE_PATH_STYLE) {
      endpoint.pathname = `/${encodePath(config.bucket)}/${encodePath(prefixed)}`;
    } else {
      endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `/${encodePath(prefixed)}`;
    }
    endpoint.search = "";
    return { config, url: endpoint };
  }

  private signedHeaders(method: string, url: URL, payloadHash: string, extraHeaders: Record<string, string>) {
    const config = this.config();
    const now = new Date();
    const timestamp = awsTimestamp(now);
    const date = timestamp.slice(0, 8);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      ...extraHeaders,
    };
    if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
    const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
    const signedHeaderNames = names.join(";");
    const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signedHeaderNames, payloadHash].join("\n");
    const scope = `${date}/${config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
    return headers;
  }

  private async request(method: "GET" | "PUT" | "DELETE", key: string, bytes?: Uint8Array, metadata?: { contentType: string; sha256: string }) {
    const { url } = this.requestTarget(key);
    const payload = bytes ?? new Uint8Array();
    const payloadHash = sha256(payload);
    const extra: Record<string, string> = {};
    if (metadata) {
      extra["content-type"] = metadata.contentType;
      extra["x-amz-meta-sha256"] = metadata.sha256;
      if (env.S3_SERVER_SIDE_ENCRYPTION) extra["x-amz-server-side-encryption"] = env.S3_SERVER_SIDE_ENCRYPTION;
      if (env.S3_SERVER_SIDE_ENCRYPTION === "aws:kms" && env.S3_KMS_KEY_ID) {
        extra["x-amz-server-side-encryption-aws-kms-key-id"] = env.S3_KMS_KEY_ID;
      }
    }
    const headers = this.signedHeaders(method, url, payloadHash, extra);
    const response = await fetch(url, {
      method,
      headers,
      body: method === "PUT" ? Buffer.from(payload) : undefined,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (response.status === 404) throw new ObjectStoreError("OBJECT_STORAGE_NOT_FOUND", "Object content was not found.");
    if (!response.ok) {
      throw new ObjectStoreError("OBJECT_STORAGE_REQUEST_FAILED", `Object storage request failed with status ${response.status}.`);
    }
    return response;
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.request("PUT", input.key, input.bytes, { contentType: input.contentType, sha256: input.sha256 });
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.request("GET", key);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.request("DELETE", key);
  }
}

let singleton: ObjectStore | undefined;

export function objectStore(): ObjectStore {
  singleton ??= env.OBJECT_STORAGE_DRIVER === "s3" ? new S3ObjectStore() : new FilesystemObjectStore();
  return singleton;
}
