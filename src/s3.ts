import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import { createTar, extractTar, listTar } from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import * as minio from "minio";
import path from "path";
import pRetry from "p-retry";

/**
 * Everything needed to talk to one S3 compatible bucket. The action entries in
 * this repository build it from action inputs; other consumers can pass their
 * own configuration straight in.
 */
export interface S3CacheConfig {
  /** Host of the S3 endpoint, without scheme, port or trailing slash. */
  endpoint: string;
  port?: number;
  useSSL: boolean;
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
  region?: string;
  bucket: string;
  /**
   * Optional object key namespace, e.g. "owner/repo". Leading and trailing
   * slashes are ignored.
   */
  prefix?: string;
  /** Retry failed S3 operations. */
  retry?: boolean;
  /** Attempts of a failed S3 operation when retry is enabled. */
  retryCount?: number;
}

export interface RestoreOptions {
  /** Primary key to look up. */
  key: string;
  /** Files, directories and glob patterns to restore. */
  paths: string[];
  /** Prefixes to fall back to when the primary key misses. */
  restoreKeys?: string[];
  /** Only check for a hit, without downloading or extracting it. */
  lookupOnly?: boolean;
  /** Preferred archive compression when writing; the object name decides on restore. */
  compression?: string;
}

export interface RestoreResult {
  /** Key that matched, without the configured object prefix. */
  matchedKey: string;
  /** Size of the stored object in bytes. */
  size: number;
  /** True when the primary key itself matched. */
  exactMatch: boolean;
}

export interface SaveOptions {
  /** Key to store the archive under. */
  key: string;
  /** Files, directories and glob patterns to archive. */
  paths: string[];
  /** Preferred archive compression. Defaults to auto. */
  compression?: string;
}

/** Thrown when no cache object matches the requested keys. */
export class CacheItemNotFoundError extends Error {
  constructor() {
    super("Cache item not found");
    this.name = "CacheItemNotFoundError";
  }
}

const MillisecondsPerSecond = 1000;

// Compression methods this fork can write and read. The archive name keeps
// upstream's cache.tgz / cache.tzst suffix, and that suffix is also what tells a
// restore which decompressor to use, so it identifies how an object was written.
const ArchiveCompressionMethods: CompressionMethod[] = [
  CompressionMethod.Gzip,
  CompressionMethod.ZstdWithoutLong,
];

export const CompressionInput = {
  Auto: "auto",
  Zstd: "zstd",
  Gzip: "gzip",
} as const;

/**
 * Compression method that produced `archiveName`, or undefined when the name
 * carries neither known archive suffix.
 */
export function compressionMethodForArchive(
  archiveName: string,
): CompressionMethod | undefined {
  return ArchiveCompressionMethods.find((method) =>
    archiveName.endsWith(cacheUtils.getCacheFileName(method)),
  );
}

export function createS3Client(config: S3CacheConfig): minio.Client {
  return new minio.Client({
    endPoint: config.endpoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    sessionToken: config.sessionToken,
    region: config.region,
  });
}

export function withRetry<A>(
  config: Pick<S3CacheConfig, "retry" | "retryCount">,
  name: string,
  fn: () => Promise<A>,
): Promise<A> {
  if (config.retry) {
    return pRetry(fn, {
      retries: config.retryCount ?? 3,
      onFailedAttempt: (error) => {
        core.info(
          `Failed to ${name}. Attempt ${error.attemptNumber} failed. ${error.message}`,
        );
      },
    });
  }
  return fn();
}

/**
 * Compression method to write a new archive with.
 *
 * `auto` (the default) mirrors upstream @actions/cache: zstd when the binary is
 * on PATH, gzip otherwise. Upstream makes that fallback silently, and
 * single-threaded gzip turns a multi-GB cache into a long stretch of no output,
 * so the fallback is reported here instead. Restores pass `reportFallback:
 * false`: a restore has nothing to slow down, so warning there would just repeat
 * the save warning on every job.
 */
export async function resolveCompressionMethod({
  requested,
  reportFallback = true,
}: {
  requested?: string;
  reportFallback?: boolean;
} = {}): Promise<CompressionMethod> {
  const input = (requested ?? "").trim().toLowerCase();
  if (input === CompressionInput.Gzip) {
    return CompressionMethod.Gzip;
  }

  let requestedMethod: string = input === "" ? CompressionInput.Auto : input;
  if (
    requestedMethod !== CompressionInput.Auto &&
    requestedMethod !== CompressionInput.Zstd
  ) {
    core.warning(
      `Unknown compression "${input}"; valid values are ${Object.values(
        CompressionInput,
      ).join(", ")}. Using ${CompressionInput.Auto}.`,
    );
    requestedMethod = CompressionInput.Auto;
  }

  // Upstream's probe: it answers Gzip only when `zstd` is missing from PATH.
  const detected = await cacheUtils.getCompressionMethod();
  if (detected !== CompressionMethod.Gzip) {
    return detected;
  }

  if (reportFallback) {
    if (requestedMethod === CompressionInput.Zstd) {
      core.warning(
        `compression: ${CompressionInput.Zstd} was requested, but zstd is not on PATH; saving with gzip instead.`,
      );
    } else {
      core.warning(
        `zstd is not on PATH; saving the cache with single-threaded gzip, which is very slow for multi-GB caches. Install zstd to speed this up, or set compression: ${CompressionInput.Gzip} to silence this warning.`,
      );
    }
  }
  return CompressionMethod.Gzip;
}

export function formatSize(value?: number, format = "bi") {
  if (!value) return "";
  const [multiple, k, suffix] = (
    format === "bi" ? [1000, "k", "B"] : [1024, "K", "iB"]
  ) as [number, string, string];
  const exp = (Math.log(value) / Math.log(multiple)) | 0;
  const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
  return (
    size +
    (exp ? (k + "MGTPEZY")[exp - 1] + suffix : "byte" + (size !== 1 ? "s" : ""))
  );
}

/** Normalized object key namespace, always either empty or ending in "/". */
function normalizePrefix(prefix?: string): string {
  if (!prefix) {
    return "";
  }
  return `${prefix.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}

/**
 * Object key of an archive. S3 keys use "/", regardless of the runner OS.
 */
export function objectKey(
  config: Pick<S3CacheConfig, "prefix">,
  key: string,
  archiveName: string,
): string {
  return path.posix.join(normalizePrefix(config.prefix), key, archiveName);
}

export function listObjects(
  mc: minio.Client,
  bucket: string,
  prefix: string,
): Promise<minio.BucketItem[]> {
  return new Promise((resolve, reject) => {
    const h = mc.listObjectsV2(bucket, prefix, true);
    const r: minio.BucketItem[] = [];
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error("list objects no result after 10 seconds"));
    }, 10000);

    h.on("data", (obj) => {
      r.push(obj);
    });
    h.on("error", (e) => {
      resolved = true;
      reject(e);
      clearTimeout(timeout);
    });
    h.on("end", () => {
      resolved = true;
      resolve(r);
      clearTimeout(timeout);
    });
  });
}

export type FindObjectResult = {
  item: minio.BucketItem;
  matchingKey: string;
};

/**
 * Object matching `key` exactly, or the newest object carrying one of the
 * `restoreKeys` prefixes. Throws CacheItemNotFoundError when nothing matches.
 */
export async function findObject(
  mc: minio.Client,
  bucket: string,
  key: string,
  restoreKeys: string[],
  prefix = "",
): Promise<FindObjectResult> {
  const namespace = normalizePrefix(prefix);
  const exactPrefix = `${namespace}${key}`;
  core.debug("Key: " + JSON.stringify(key));
  core.debug("Restore keys: " + JSON.stringify(restoreKeys));

  core.debug(`Finding exact match for: ${key}`);
  const keyMatches = await listObjects(mc, bucket, exactPrefix);
  core.debug(`Found ${JSON.stringify(keyMatches, null, 2)}`);
  if (keyMatches.length > 0) {
    // S3 keys use '/', regardless of the runner OS. Also accept objects saved by
    // older Windows actions on endpoints that preserve their backslash keys.
    const exactMatch = keyMatches.find(
      (obj) =>
        obj.name?.startsWith(`${exactPrefix}/`) ||
        obj.name?.startsWith(`${exactPrefix}\\`),
    );
    if (exactMatch) {
      const result = { item: exactMatch, matchingKey: key };
      core.debug(`Found an exact match; using ${JSON.stringify(result)}`);
      return result;
    }
  }
  core.debug(`Didn't find an exact match`);

  for (const restoreKey of restoreKeys) {
    core.debug(`Finding object with prefix: ${restoreKey}`);
    let objects = await listObjects(mc, bucket, `${namespace}${restoreKey}`);
    // Accept objects from either era: a runner without zstd writes cache.tgz, and
    // the decompressor is picked from the object name after download.
    objects = objects.filter(
      (o) =>
        o.name !== undefined &&
        compressionMethodForArchive(o.name) !== undefined,
    );
    core.debug(`Found ${JSON.stringify(objects, null, 2)}`);
    if (objects.length < 1) {
      continue;
    }
    const sorted = objects.sort(
      (a, b) =>
        (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0),
    );
    const result = { item: sorted[0], matchingKey: restoreKey };
    core.debug(`Using latest ${JSON.stringify(result)}`);
    return result;
  }
  throw new CacheItemNotFoundError();
}

/**
 * Download and extract the cache object matching the requested keys.
 *
 * Returns undefined when no object matches. S3 failures (unreachable endpoint,
 * missing permissions, corrupted archive, ...) throw, so a caller can tell a
 * miss apart from a broken backend. The caller owns any fallback behaviour.
 */
export async function restoreFromS3(
  config: S3CacheConfig,
  options: RestoreOptions,
): Promise<RestoreResult | undefined> {
  const mc = createS3Client(config);

  // The local compression setting only decides which archive name to prefer
  // while looking the object up; the object name decides how it is extracted.
  const preferredCompressionMethod = await resolveCompressionMethod({
    requested: options.compression,
    reportFallback: false,
  });
  const archiveFolder = await cacheUtils.createTempDirectory();

  let found: FindObjectResult;
  try {
    found = await findObject(
      mc,
      config.bucket,
      options.key,
      options.restoreKeys ?? [],
      config.prefix,
    );
  } catch (error) {
    if (error instanceof CacheItemNotFoundError) {
      core.info(
        `Cache miss for key ${options.key} in s3. Bucket: ${config.bucket}`,
      );
      return undefined;
    }
    throw error;
  }

  const { item: obj, matchingKey } = found;
  core.debug("found cache object");

  // Cached objects may have been written by a runner with a different
  // compression setup than this one, so trust the object name over the local
  // environment and stay able to restore older gzip archives.
  const archiveName = path.posix.basename(obj.name ?? "");
  const compressionMethod =
    compressionMethodForArchive(archiveName) ?? preferredCompressionMethod;
  const archivePath = path.join(
    archiveFolder,
    cacheUtils.getCacheFileName(compressionMethod),
  );
  if (compressionMethod !== preferredCompressionMethod) {
    core.info(
      `Cache object ${archiveName} uses ${compressionMethod} compression (local default: ${preferredCompressionMethod}).`,
    );
  }

  const result: RestoreResult = {
    matchedKey: matchingKey,
    size: obj.size ?? 0,
    exactMatch: matchingKey === options.key,
  };

  if (options.lookupOnly) {
    if (result.exactMatch && result.size > 0) {
      core.info(
        `Cache Hit. NOT Downloading cache from s3 because lookup-only is set. bucket: ${config.bucket}, object: ${obj.name}`,
      );
    } else {
      core.info(
        `Cache Miss or cache size is 0. NOT Downloading cache from s3 because lookup-only is set. bucket: ${config.bucket}, object: ${obj.name}`,
      );
    }
    return result;
  }

  core.info(
    `Downloading cache from s3 to ${archivePath}. bucket: ${config.bucket}, object: ${obj.name}`,
  );
  await withRetry(config, "fGetObject", () =>
    mc.fGetObject(config.bucket, obj.name!, archivePath),
  );

  if (core.isDebug()) {
    await listTar(archivePath, compressionMethod);
  }

  core.info(`Cache Size: ${formatSize(result.size)} (${result.size} bytes)`);

  await extractTar(archivePath, compressionMethod);
  core.info("Cache restored from s3 successfully");
  return result;
}

/**
 * Archive the given paths and upload them as one cache object.
 *
 * Throws on any failure, including upload errors. The caller owns any fallback
 * behaviour.
 */
export async function saveToS3(
  config: S3CacheConfig,
  options: SaveOptions,
): Promise<void> {
  const mc = createS3Client(config);
  const compressionMethod = await resolveCompressionMethod({
    requested: options.compression,
  });
  const cachePaths = await cacheUtils.resolvePaths(options.paths);
  core.debug("Cache Paths:");
  core.debug(`${JSON.stringify(cachePaths)}`);

  const archiveFolder = await cacheUtils.createTempDirectory();
  const cacheFileName = cacheUtils.getCacheFileName(compressionMethod);
  const archivePath = path.join(archiveFolder, cacheFileName);

  core.debug(`Archive Path: ${archivePath}`);

  core.info(
    `Creating cache archive ${cacheFileName} (compression: ${compressionMethod})`,
  );
  const archiveStartedAt = Date.now();
  await createTar(archiveFolder, cachePaths, compressionMethod);
  const archiveSeconds = (
    (Date.now() - archiveStartedAt) /
    MillisecondsPerSecond
  ).toFixed(1);
  core.info(
    `Cache archive created in ${archiveSeconds}s: ${cacheFileName}, ${formatSize(
      cacheUtils.getArchiveFileSizeInBytes(archivePath),
    )} (compression: ${compressionMethod})`,
  );
  if (core.isDebug()) {
    await listTar(archivePath, compressionMethod);
  }

  const object = objectKey(config, options.key, cacheFileName);

  core.info(`Uploading tar to s3. Bucket: ${config.bucket}, Object: ${object}`);
  await withRetry(config, "fPutObject", () =>
    mc.fPutObject(config.bucket, object, archivePath, {}),
  );
  core.info("Cache saved to s3 successfully");
}
