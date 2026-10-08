import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { State } from "./state";
import {
  getInput,
  getInputAsArray,
  getInputAsBoolean,
  isGhes,
  restoreFromS3,
  s3ConfigFromInputs,
  saveMatchedKey,
  setCacheHitOutput,
  setCacheMatchedKeyOutput,
  setCacheSizeOutput,
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

    let restoredFromS3 = false;
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

      const config = s3ConfigFromInputs();
      config.bucket = bucket;

      const result = await restoreFromS3(config, {
        key,
        paths,
        restoreKeys,
        lookupOnly,
        compression: getInput("compression"),
      });

      if (result !== undefined) {
        saveMatchedKey(result.matchedKey);
        setCacheHitOutput(result.exactMatch);
        setCacheSizeOutput(result.size);
        setCacheMatchedKeyOutput(result.matchedKey);
        restoredFromS3 = true;
      }
    } catch (e) {
      core.info("Restore s3 cache failed: " + e.message);
    }

    if (restoredFromS3) {
      return;
    }

    // A miss and a broken backend both end up here: the GitHub cache may still
    // hold a usable entry, so it stays in play when a fallback was requested.
    setCacheHitOutput(false);
    setCacheMatchedKeyOutput("");

    if (!useFallback) {
      core.info(`No cache restored from s3 for key: ${key}`);
      return;
    }
    if (isGhes()) {
      core.warning("Cache fallback is not supported on Github Enterpise.");
      return;
    }

    core.info("Restore cache using fallback cache");
    const fallbackMatchingKey = await cache.restoreCache(
      paths,
      key,
      restoreKeys,
    );
    if (fallbackMatchingKey) {
      saveMatchedKey(fallbackMatchingKey);
      setCacheHitOutput(fallbackMatchingKey === key);
      setCacheMatchedKeyOutput(fallbackMatchingKey);
      core.info("Fallback cache restored successfully");
    } else {
      core.info("Fallback cache restore failed");
    }
  } catch (e) {
    core.setFailed(e.message);
  }
}

restoreCache();
