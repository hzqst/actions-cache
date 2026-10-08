"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRetry = exports.saveToS3 = exports.restoreFromS3 = exports.listObjects = exports.formatSize = exports.findObject = exports.createS3Client = exports.compressionMethodForArchive = exports.CompressionInput = exports.CacheItemNotFoundError = void 0;
exports.isGhes = isGhes;
exports.getInput = getInput;
exports.s3ConfigFromInputs = s3ConfigFromInputs;
exports.newMinio = newMinio;
exports.getInputAsBoolean = getInputAsBoolean;
exports.getInputAsArray = getInputAsArray;
exports.getInputAsInt = getInputAsInt;
exports.resolveCompressionMethod = resolveCompressionMethod;
exports.setCacheHitOutput = setCacheHitOutput;
exports.setCacheSizeOutput = setCacheSizeOutput;
exports.setCacheMatchedKeyOutput = setCacheMatchedKeyOutput;
exports.saveMatchedKey = saveMatchedKey;
exports.isExactKeyMatch = isExactKeyMatch;
exports.saveCache = saveCache;
const cache = __importStar(require("@actions/cache"));
const core = __importStar(require("@actions/core"));
const s3_1 = require("./s3");
Object.defineProperty(exports, "CacheItemNotFoundError", { enumerable: true, get: function () { return s3_1.CacheItemNotFoundError; } });
Object.defineProperty(exports, "CompressionInput", { enumerable: true, get: function () { return s3_1.CompressionInput; } });
Object.defineProperty(exports, "compressionMethodForArchive", { enumerable: true, get: function () { return s3_1.compressionMethodForArchive; } });
Object.defineProperty(exports, "createS3Client", { enumerable: true, get: function () { return s3_1.createS3Client; } });
Object.defineProperty(exports, "findObject", { enumerable: true, get: function () { return s3_1.findObject; } });
Object.defineProperty(exports, "formatSize", { enumerable: true, get: function () { return s3_1.formatSize; } });
Object.defineProperty(exports, "listObjects", { enumerable: true, get: function () { return s3_1.listObjects; } });
Object.defineProperty(exports, "restoreFromS3", { enumerable: true, get: function () { return s3_1.restoreFromS3; } });
Object.defineProperty(exports, "saveToS3", { enumerable: true, get: function () { return s3_1.saveToS3; } });
Object.defineProperty(exports, "withRetry", { enumerable: true, get: function () { return s3_1.withRetry; } });
const state_1 = require("./state");
function isGhes() {
    const ghUrl = new URL(process.env["GITHUB_SERVER_URL"] || "https://github.com");
    return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}
function getInput(key, envKey) {
    let result;
    if (envKey) {
        result = process.env[envKey];
    }
    if (result === undefined) {
        result = core.getInput(key);
    }
    return result;
}
/**
 * S3 configuration from the action inputs. `overrides` exist because inputs are
 * re-evaluated before the post action, so it passes the values captured during
 * the restore instead.
 */
function s3ConfigFromInputs(overrides = {}) {
    var _a, _b, _c, _d;
    return {
        endpoint: core.getInput("endpoint"),
        port: getInputAsInt("port"),
        useSSL: !getInputAsBoolean("insecure"),
        accessKey: (_a = overrides.accessKey) !== null && _a !== void 0 ? _a : getInput("accessKey", "AWS_ACCESS_KEY_ID"),
        secretKey: (_b = overrides.secretKey) !== null && _b !== void 0 ? _b : getInput("secretKey", "AWS_SECRET_ACCESS_KEY"),
        sessionToken: (_c = overrides.sessionToken) !== null && _c !== void 0 ? _c : getInput("sessionToken", "AWS_SESSION_TOKEN"),
        region: (_d = overrides.region) !== null && _d !== void 0 ? _d : getInput("region", "AWS_REGION"),
        bucket: core.getInput("bucket"),
        retry: getInputAsBoolean("retry"),
        retryCount: getInputAsInt("retry-count"),
    };
}
function newMinio(overrides = {}) {
    return (0, s3_1.createS3Client)(s3ConfigFromInputs(overrides));
}
function getInputAsBoolean(name, options) {
    return core.getInput(name, options) === "true";
}
function getInputAsArray(name, options) {
    return core
        .getInput(name, options)
        .split("\n")
        .map((s) => s.trim())
        .filter((x) => x !== "");
}
function getInputAsInt(name, options) {
    const value = parseInt(core.getInput(name, options));
    if (isNaN(value) || value < 0) {
        return undefined;
    }
    return value;
}
/** Compression method for new archives, from the `compression` input. */
function resolveCompressionMethod() {
    return __awaiter(this, arguments, void 0, function* ({ reportFallback = true } = {}) {
        return (0, s3_1.resolveCompressionMethod)({
            requested: getInput("compression"),
            reportFallback,
        });
    });
}
function setCacheHitOutput(isCacheHit) {
    core.setOutput("cache-hit", isCacheHit.toString());
}
function setCacheSizeOutput(cacheSize) {
    core.setOutput("cache-size", cacheSize.toString());
}
function setCacheMatchedKeyOutput(cacheMatchedKey) {
    core.setOutput("cache-matched-key", cacheMatchedKey);
}
function saveMatchedKey(matchedKey) {
    return core.saveState(state_1.State.MatchedKey, matchedKey);
}
function getMatchedKey() {
    return core.getState(state_1.State.MatchedKey);
}
function isExactKeyMatch() {
    const matchedKey = getMatchedKey();
    const inputKey = core.getState(state_1.State.PrimaryKey);
    const result = getMatchedKey() === inputKey;
    core.debug(`isExactKeyMatch: matchedKey=${matchedKey} inputKey=${inputKey}, result=${result}`);
    return result;
}
function saveCache(standalone) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            if (!standalone && isExactKeyMatch()) {
                core.info("Cache was exact key match, not saving");
                return;
            }
            const bucket = core.getInput("bucket", { required: true });
            // Inputs are re-evaluted before the post action, so we want the original key
            const key = standalone ? core.getInput("key", { required: true }) : core.getState(state_1.State.PrimaryKey);
            const useFallback = getInputAsBoolean("use-fallback");
            const paths = getInputAsArray("path");
            try {
                // Inputs are re-evaluted before the post action, so we want the original keys & tokens
                const config = s3ConfigFromInputs({
                    accessKey: standalone ? undefined : core.getState(state_1.State.AccessKey),
                    secretKey: standalone ? undefined : core.getState(state_1.State.SecretKey),
                    sessionToken: standalone ? undefined : core.getState(state_1.State.SessionToken),
                    region: standalone ? undefined : core.getState(state_1.State.Region),
                });
                config.bucket = bucket;
                yield (0, s3_1.saveToS3)(config, {
                    key,
                    paths,
                    compression: getInput("compression"),
                });
            }
            catch (e) {
                if (useFallback) {
                    if (isGhes()) {
                        core.warning("Cache fallback is not supported on Github Enterpise.");
                    }
                    else {
                        core.info("Saving cache using fallback");
                        yield cache.saveCache(paths, key);
                        core.info("Save cache using fallback successfully");
                    }
                }
                else {
                    core.debug("skipped fallback cache");
                    core.warning("Save s3 cache failed: " + e.message);
                }
            }
        }
        catch (e) {
            core.info("warning: " + e.message);
        }
    });
}
