import * as cache from "@actions/cache";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { extractTar, listTar } from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import * as path from "path";
import { State } from "./state";
import {
  compressionMethodForArchive,
  findObject,
  formatSize,
  getInputAsArray,
  getInputAsBoolean,
  isGhes,
  newMinio,
  resolveCompressionMethod,
  setCacheHitOutput,
  setCacheMatchedKeyOutput,
  setCacheSizeOutput,
  saveMatchedKey,
  getInput,
  withRetry,
} from "./utils";

process.on("uncaughtException", (e) => core.info("warning: " + e.message));

async function restoreCache() {
  try {
    const bucket = core.getInput("bucket", { required: true });
    const key = core.getInput("key", { required: true });
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");
    const restoreKeys = getInputAsArray("restore-keys");
    const lookupOnly = getInputAsBoolean("lookup-only");

    try {
      // Inputs are re-evaluted before the post action, so we want to store the original values
      core.saveState(State.PrimaryKey, key);
      core.saveState(
        State.AccessKey,
        getInput("accessKey", "AWS_ACCESS_KEY_ID"),
      );
      core.saveState(
        State.SecretKey,
        getInput("secretKey", "AWS_SECRET_ACCESS_KEY"),
      );
      core.saveState(
        State.SessionToken,
        getInput("sessionToken", "AWS_SESSION_TOKEN"),
      );
      core.saveState(State.Region, getInput("region", "AWS_REGION"));

      const mc = newMinio();

      // The local compression setting only decides which archive name to prefer
      // while looking the object up; the object name decides how it is extracted.
      const preferredCompressionMethod = await resolveCompressionMethod({
        reportFallback: false,
      });
      const archiveFolder = await utils.createTempDirectory();

      const { item: obj, matchingKey } = await findObject(
        mc,
        bucket,
        key,
        restoreKeys,
      );
      core.debug("found cache object");

      // Cached objects may have been written by a runner with a different
      // compression setup than this one, so trust the object name over the local
      // environment and stay able to restore older gzip archives.
      const archiveName = path.posix.basename(obj.name ?? "");
      const compressionMethod =
        compressionMethodForArchive(archiveName) ?? preferredCompressionMethod;
      const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod),
      );
      if (compressionMethod !== preferredCompressionMethod) {
        core.info(
          `Cache object ${archiveName} uses ${compressionMethod} compression (local default: ${preferredCompressionMethod}).`,
        );
      }

      saveMatchedKey(matchingKey);
      const cacheHit = matchingKey === key;
      setCacheHitOutput(cacheHit);
      setCacheSizeOutput(obj.size);
      setCacheMatchedKeyOutput(matchingKey);
      if (lookupOnly) {
        if (cacheHit && obj.size > 0) {
          core.info(
            `Cache Hit. NOT Downloading cache from s3 because lookup-only is set. bucket: ${bucket}, object: ${obj.name}`,
          );
        } else {
          core.info(
            `Cache Miss or cache size is 0. NOT Downloading cache from s3 because lookup-only is set. bucket: ${bucket}, object: ${obj.name}`,
          )
        }
      } else {
        core.info(
          `Downloading cache from s3 to ${archivePath}. bucket: ${bucket}, object: ${obj.name}`,
        );
        await withRetry("fGetObject", () => mc.fGetObject(bucket, obj.name!, archivePath));

        if (core.isDebug()) {
          await listTar(archivePath, compressionMethod);
        }

        core.info(`Cache Size: ${formatSize(obj.size)} (${obj.size} bytes)`);

        await extractTar(archivePath, compressionMethod);
        core.info("Cache restored from s3 successfully");
      }
    } catch (e) {
      core.info("Restore s3 cache failed: " + e.message);
      setCacheHitOutput(false);
      setCacheMatchedKeyOutput("");
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Restore cache using fallback cache");
          const fallbackMatchingKey = await cache.restoreCache(
            paths,
            key,
            restoreKeys,
          );
          if (fallbackMatchingKey) {
            setCacheHitOutput(fallbackMatchingKey === key);
            setCacheMatchedKeyOutput(fallbackMatchingKey);
            core.info("Fallback cache restored successfully");
          } else {
            core.info("Fallback cache restore failed");
          }
        }
      }
    }
  } catch (e) {
    core.setFailed(e.message);
  }
}

restoreCache();
