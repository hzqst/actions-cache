import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import * as minio from "minio";
import { State } from "./state";
import path from "path";
import {createTar, listTar} from "@actions/cache/lib/internal/tar";
import * as cache from "@actions/cache";
import pRetry from 'p-retry';

export function isGhes(): boolean {
  const ghUrl = new URL(
    process.env["GITHUB_SERVER_URL"] || "https://github.com"
  );
  return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}

export function getInput(key: string, envKey?: string) {
  let result;
  if (envKey) {
    result = process.env[envKey]
  }
  if (result === undefined) {
    result = core.getInput(key);
  }
  return result;
}

export function newMinio({
  accessKey,
  secretKey,
  sessionToken,
  region,
}: {
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
  region?: string;
} = {}) {
  return new minio.Client({
    endPoint: core.getInput("endpoint"),
    port: getInputAsInt("port"),
    useSSL: !getInputAsBoolean("insecure"),
    accessKey: accessKey ?? getInput("accessKey", "AWS_ACCESS_KEY_ID"),
    secretKey: secretKey ?? getInput("secretKey", "AWS_SECRET_ACCESS_KEY"),
    sessionToken: sessionToken ?? getInput("sessionToken", "AWS_SESSION_TOKEN"),
    region: region ?? getInput("region", "AWS_REGION"),
  });
}

export function withRetry<A>(name: string, fn: () => Promise<A>): Promise<A> {
  if (getInputAsBoolean("retry")) {
    return pRetry(fn, {
      retries: getInputAsInt("retry-count") ?? 3,
      onFailedAttempt: (error) => {
        core.info(
          `Failed to ${name}. Attempt ${error.attemptNumber} failed. ${error.message}`
        );
      },
    });
  } else {
    return fn();
  }
}

export function getInputAsBoolean(
  name: string,
  options?: core.InputOptions
): boolean {
  return core.getInput(name, options) === "true";
}

export function getInputAsArray(
  name: string,
  options?: core.InputOptions
): string[] {
  return core
    .getInput(name, options)
    .split("\n")
    .map((s) => s.trim())
    .filter((x) => x !== "");
}

export function getInputAsInt(
  name: string,
  options?: core.InputOptions
): number | undefined {
  const value = parseInt(core.getInput(name, options));
  if (isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}

const MillisecondsPerSecond = 1000;

// Compression methods this fork can write and read. The archive name keeps
// upstream's cache.tgz / cache.tzst suffix, and that suffix is also what tells a
// restore which decompressor to use, so it identifies how an object was written.
const ArchiveCompressionMethods: CompressionMethod[] = [
  CompressionMethod.Gzip,
  CompressionMethod.ZstdWithoutLong,
];

/**
 * Compression method that produced `archiveName`, or undefined when the name
 * carries neither known archive suffix.
 */
export function compressionMethodForArchive(
  archiveName: string
): CompressionMethod | undefined {
  return ArchiveCompressionMethods.find((method) =>
    archiveName.endsWith(utils.getCacheFileName(method))
  );
}

export const CompressionInput = {
  Auto: "auto",
  Zstd: "zstd",
  Gzip: "gzip",
} as const;

/**
 * Compression method to write a new archive with, from the `compression` input.
 *
 * `auto` (the default) mirrors upstream @actions/cache: zstd when the binary is
 * on PATH, gzip otherwise. Upstream makes that fallback silently, and
 * single-threaded gzip turns a multi-GB cache into a long stretch of no output,
 * so the fallback is reported here instead. Restores resolve the same input but
 * pass `reportFallback: false`: a restore has nothing to slow down, so warning
 * there would just repeat the save warning on every job.
 */
export async function resolveCompressionMethod(
  { reportFallback = true }: { reportFallback?: boolean } = {}
): Promise<CompressionMethod> {
  const input = (getInput("compression") ?? "").trim().toLowerCase();
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
        CompressionInput
      ).join(", ")}. Using ${CompressionInput.Auto}.`
    );
    requestedMethod = CompressionInput.Auto;
  }

  // Upstream's probe: it answers Gzip only when `zstd` is missing from PATH.
  const detected = await utils.getCompressionMethod();
  if (detected !== CompressionMethod.Gzip) {
    return detected;
  }

  if (reportFallback) {
    if (requestedMethod === CompressionInput.Zstd) {
      core.warning(
        `compression: ${CompressionInput.Zstd} was requested, but zstd is not on PATH; saving with gzip instead.`
      );
    } else {
      core.warning(
        `zstd is not on PATH; saving the cache with single-threaded gzip, which is very slow for multi-GB caches. Install zstd to speed this up, or set compression: ${CompressionInput.Gzip} to silence this warning.`
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

export function setCacheHitOutput(isCacheHit: boolean): void {
  core.setOutput("cache-hit", isCacheHit.toString());
}

export function setCacheSizeOutput(cacheSize: number): void {
  core.setOutput("cache-size", cacheSize.toString())
}

export function setCacheMatchedKeyOutput(cacheMatchedKey: string): void {
  core.setOutput("cache-matched-key", cacheMatchedKey)
}

type FindObjectResult = {
  item: minio.BucketItem;
  matchingKey: string;
};

export async function findObject(
  mc: minio.Client,
  bucket: string,
  key: string,
  restoreKeys: string[]
): Promise<FindObjectResult> {
  core.debug("Key: " + JSON.stringify(key));
  core.debug("Restore keys: " + JSON.stringify(restoreKeys));

  core.debug(`Finding exact match for: ${key}`);
  const keyMatches = await listObjects(mc, bucket, key);
  core.debug(`Found ${JSON.stringify(keyMatches, null, 2)}`);
  if (keyMatches.length > 0) {
    // S3 keys use '/', regardless of the runner OS. Also accept objects saved by
    // older Windows actions on endpoints that preserve their backslash keys.
    const exactMatch = keyMatches.find((obj) =>
      obj.name?.startsWith(key + "/") || obj.name?.startsWith(key + "\\")
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
    let objects = await listObjects(mc, bucket, restoreKey);
    // Accept objects from either era: a runner without zstd writes cache.tgz, and
    // the decompressor is picked from the object name after download.
    objects = objects.filter(
      (o) => o.name !== undefined && compressionMethodForArchive(o.name) !== undefined
    );
    core.debug(`Found ${JSON.stringify(objects, null, 2)}`);
    if (objects.length < 1) {
      continue;
    }
    const sorted = objects.sort(
      (a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0)
    );
    const result = { item: sorted[0], matchingKey: restoreKey };
    core.debug(`Using latest ${JSON.stringify(result)}`);
    return result;
  }
  throw new Error("Cache item not found");
}

export function listObjects(
  mc: minio.Client,
  bucket: string,
  prefix: string
): Promise<minio.BucketItem[]> {
  return new Promise((resolve, reject) => {
    const h = mc.listObjectsV2(bucket, prefix, true);
    const r: minio.BucketItem[] = [];
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved)
        reject(new Error("list objects no result after 10 seconds"));
    }, 10000);

    h.on("data", (obj) => {
      r.push(obj);
    });
    h.on("error", (e) => {
      resolved = true;
      reject(e);
      clearTimeout(timeout)
    });
    h.on("end", () => {
      resolved = true;
      resolve(r);
      clearTimeout(timeout)
    });
  });
}

export function saveMatchedKey(matchedKey: string) {
  return core.saveState(State.MatchedKey, matchedKey);
}

function getMatchedKey() {
  return core.getState(State.MatchedKey);
}

export function isExactKeyMatch(): boolean {
  const matchedKey = getMatchedKey();
  const inputKey = core.getState(State.PrimaryKey);
  const result = getMatchedKey() === inputKey;
  core.debug(
    `isExactKeyMatch: matchedKey=${matchedKey} inputKey=${inputKey}, result=${result}`
  );
  return result;
}

export async function saveCache(standalone: boolean) {
  try {
    if (!standalone && isExactKeyMatch()) {
      core.info("Cache was exact key match, not saving");
      return;
    }

    const bucket = core.getInput("bucket", { required: true });
    // Inputs are re-evaluted before the post action, so we want the original key
    const key = standalone ? core.getInput("key", { required: true }) : core.getState(State.PrimaryKey);
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");

    try {
      const mc = newMinio({
        // Inputs are re-evaluted before the post action, so we want the original keys & tokens
        accessKey: standalone ? getInput("accessKey", "AWS_ACCESS_KEY_ID") : core.getState(State.AccessKey),
        secretKey: standalone ? getInput("secretKey", "AWS_SECRET_ACCESS_KEY") : core.getState(State.SecretKey),
        sessionToken: standalone ? getInput("sessionToken", "AWS_SESSION_TOKEN") : core.getState(State.SessionToken),
        region: standalone ? getInput("region", "AWS_REGION") : core.getState(State.Region),
      });

      const compressionMethod = await resolveCompressionMethod();
      const cachePaths = await utils.resolvePaths(paths);
      core.debug("Cache Paths:");
      core.debug(`${JSON.stringify(cachePaths)}`);

      const archiveFolder = await utils.createTempDirectory();
      const cacheFileName = utils.getCacheFileName(compressionMethod);
      const archivePath = path.join(archiveFolder, cacheFileName);

      core.debug(`Archive Path: ${archivePath}`);

      core.info(`Creating cache archive ${cacheFileName} (compression: ${compressionMethod})`);
      const archiveStartedAt = Date.now();
      await createTar(archiveFolder, cachePaths, compressionMethod);
      const archiveSeconds = (
        (Date.now() - archiveStartedAt) / MillisecondsPerSecond
      ).toFixed(1);
      core.info(
        `Cache archive created in ${archiveSeconds}s: ${cacheFileName}, ${formatSize(
          utils.getArchiveFileSizeInBytes(archivePath)
        )} (compression: ${compressionMethod})`
      );
      if (core.isDebug()) {
        await listTar(archivePath, compressionMethod);
      }

      const object = path.posix.join(key, cacheFileName);

      core.info(`Uploading tar to s3. Bucket: ${bucket}, Object: ${object}`);
      await withRetry("fPutObject", () => mc.fPutObject(bucket, object, archivePath, {}));
      core.info("Cache saved to s3 successfully");
    } catch (e) {
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Saving cache using fallback");
          await cache.saveCache(paths, key);
          core.info("Save cache using fallback successfully");
        }
      } else {
        core.debug("skipped fallback cache");
        core.warning("Save s3 cache failed: " + e.message);
      }
    }
  } catch (e) {
    core.info("warning: " + e.message);
  }
}
