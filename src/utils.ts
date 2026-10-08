import * as cache from "@actions/cache";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as core from "@actions/core";
import * as minio from "minio";
import {
  CacheItemNotFoundError,
  CompressionInput,
  compressionMethodForArchive,
  createS3Client,
  findObject,
  formatSize,
  listObjects,
  resolveCompressionMethod as resolveCompressionMethodFor,
  restoreFromS3,
  type S3CacheConfig,
  type SaveOptions,
  saveToS3,
  withRetry,
} from "./s3";
import { State } from "./state";

// The S3 building blocks live in ./s3 so they can be used as a library. They are
// re-exported here for the action entries and for backwards compatibility.
export {
  CacheItemNotFoundError,
  CompressionInput,
  compressionMethodForArchive,
  createS3Client,
  findObject,
  formatSize,
  listObjects,
  restoreFromS3,
  saveToS3,
  withRetry,
};
export type { S3CacheConfig, SaveOptions };

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

export type S3CredentialOverrides = Pick<
  S3CacheConfig,
  "accessKey" | "secretKey" | "sessionToken" | "region"
>;

/**
 * S3 configuration from the action inputs. `overrides` exist because inputs are
 * re-evaluated before the post action, so it passes the values captured during
 * the restore instead.
 */
export function s3ConfigFromInputs(
  overrides: Partial<S3CredentialOverrides> = {}
): S3CacheConfig {
  return {
    endpoint: core.getInput("endpoint"),
    port: getInputAsInt("port"),
    useSSL: !getInputAsBoolean("insecure"),
    accessKey: overrides.accessKey ?? getInput("accessKey", "AWS_ACCESS_KEY_ID"),
    secretKey: overrides.secretKey ?? getInput("secretKey", "AWS_SECRET_ACCESS_KEY"),
    sessionToken:
      overrides.sessionToken ?? getInput("sessionToken", "AWS_SESSION_TOKEN"),
    region: overrides.region ?? getInput("region", "AWS_REGION"),
    bucket: core.getInput("bucket"),
    retry: getInputAsBoolean("retry"),
    retryCount: getInputAsInt("retry-count"),
  };
}

export function newMinio(overrides: S3CredentialOverrides = {}): minio.Client {
  return createS3Client(s3ConfigFromInputs(overrides));
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

/** Compression method for new archives, from the `compression` input. */
export async function resolveCompressionMethod(
  { reportFallback = true }: { reportFallback?: boolean } = {}
): Promise<CompressionMethod> {
  return resolveCompressionMethodFor({
    requested: getInput("compression"),
    reportFallback,
  });
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
      // Inputs are re-evaluted before the post action, so we want the original keys & tokens
      const config = s3ConfigFromInputs({
        accessKey: standalone ? undefined : core.getState(State.AccessKey),
        secretKey: standalone ? undefined : core.getState(State.SecretKey),
        sessionToken: standalone ? undefined : core.getState(State.SessionToken),
        region: standalone ? undefined : core.getState(State.Region),
      });
      config.bucket = bucket;

      await saveToS3(config, {
        key,
        paths,
        compression: getInput("compression"),
      });
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
