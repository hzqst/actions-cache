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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompressionInput = exports.CacheItemNotFoundError = void 0;
exports.compressionMethodForArchive = compressionMethodForArchive;
exports.createS3Client = createS3Client;
exports.withRetry = withRetry;
exports.resolveCompressionMethod = resolveCompressionMethod;
exports.formatSize = formatSize;
exports.objectKey = objectKey;
exports.listObjects = listObjects;
exports.findObject = findObject;
exports.restoreFromS3 = restoreFromS3;
exports.saveToS3 = saveToS3;
const constants_1 = require("@actions/cache/lib/internal/constants");
const cacheUtils = __importStar(require("@actions/cache/lib/internal/cacheUtils"));
const tar_1 = require("@actions/cache/lib/internal/tar");
const core = __importStar(require("@actions/core"));
const minio = __importStar(require("minio"));
const path_1 = __importDefault(require("path"));
const p_retry_1 = __importDefault(require("p-retry"));
/** Thrown when no cache object matches the requested keys. */
class CacheItemNotFoundError extends Error {
    constructor() {
        super("Cache item not found");
        this.name = "CacheItemNotFoundError";
    }
}
exports.CacheItemNotFoundError = CacheItemNotFoundError;
const MillisecondsPerSecond = 1000;
// Compression methods this fork can write and read. The archive name keeps
// upstream's cache.tgz / cache.tzst suffix, and that suffix is also what tells a
// restore which decompressor to use, so it identifies how an object was written.
const ArchiveCompressionMethods = [
    constants_1.CompressionMethod.Gzip,
    constants_1.CompressionMethod.ZstdWithoutLong,
];
exports.CompressionInput = {
    Auto: "auto",
    Zstd: "zstd",
    Gzip: "gzip",
};
/**
 * Compression method that produced `archiveName`, or undefined when the name
 * carries neither known archive suffix.
 */
function compressionMethodForArchive(archiveName) {
    return ArchiveCompressionMethods.find((method) => archiveName.endsWith(cacheUtils.getCacheFileName(method)));
}
function createS3Client(config) {
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
function withRetry(config, name, fn) {
    var _a;
    if (config.retry) {
        return (0, p_retry_1.default)(fn, {
            retries: (_a = config.retryCount) !== null && _a !== void 0 ? _a : 3,
            onFailedAttempt: (error) => {
                core.info(`Failed to ${name}. Attempt ${error.attemptNumber} failed. ${error.message}`);
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
function resolveCompressionMethod() {
    return __awaiter(this, arguments, void 0, function* ({ requested, reportFallback = true, } = {}) {
        const input = (requested !== null && requested !== void 0 ? requested : "").trim().toLowerCase();
        if (input === exports.CompressionInput.Gzip) {
            return constants_1.CompressionMethod.Gzip;
        }
        let requestedMethod = input === "" ? exports.CompressionInput.Auto : input;
        if (requestedMethod !== exports.CompressionInput.Auto &&
            requestedMethod !== exports.CompressionInput.Zstd) {
            core.warning(`Unknown compression "${input}"; valid values are ${Object.values(exports.CompressionInput).join(", ")}. Using ${exports.CompressionInput.Auto}.`);
            requestedMethod = exports.CompressionInput.Auto;
        }
        // Upstream's probe: it answers Gzip only when `zstd` is missing from PATH.
        const detected = yield cacheUtils.getCompressionMethod();
        if (detected !== constants_1.CompressionMethod.Gzip) {
            return detected;
        }
        if (reportFallback) {
            if (requestedMethod === exports.CompressionInput.Zstd) {
                core.warning(`compression: ${exports.CompressionInput.Zstd} was requested, but zstd is not on PATH; saving with gzip instead.`);
            }
            else {
                core.warning(`zstd is not on PATH; saving the cache with single-threaded gzip, which is very slow for multi-GB caches. Install zstd to speed this up, or set compression: ${exports.CompressionInput.Gzip} to silence this warning.`);
            }
        }
        return constants_1.CompressionMethod.Gzip;
    });
}
function formatSize(value, format = "bi") {
    if (!value)
        return "";
    const [multiple, k, suffix] = (format === "bi" ? [1000, "k", "B"] : [1024, "K", "iB"]);
    const exp = (Math.log(value) / Math.log(multiple)) | 0;
    const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
    return (size +
        (exp ? (k + "MGTPEZY")[exp - 1] + suffix : "byte" + (size !== 1 ? "s" : "")));
}
/** Normalized object key namespace, always either empty or ending in "/". */
function normalizePrefix(prefix) {
    if (!prefix) {
        return "";
    }
    return `${prefix.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}
/**
 * Object key of an archive. S3 keys use "/", regardless of the runner OS.
 */
function objectKey(config, key, archiveName) {
    return path_1.default.posix.join(normalizePrefix(config.prefix), key, archiveName);
}
function listObjects(mc, bucket, prefix) {
    return new Promise((resolve, reject) => {
        const h = mc.listObjectsV2(bucket, prefix, true);
        const r = [];
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
            clearTimeout(timeout);
        });
        h.on("end", () => {
            resolved = true;
            resolve(r);
            clearTimeout(timeout);
        });
    });
}
/**
 * Object matching `key` exactly, or the newest object carrying one of the
 * `restoreKeys` prefixes. Throws CacheItemNotFoundError when nothing matches.
 */
function findObject(mc_1, bucket_1, key_1, restoreKeys_1) {
    return __awaiter(this, arguments, void 0, function* (mc, bucket, key, restoreKeys, prefix = "") {
        const namespace = normalizePrefix(prefix);
        const exactPrefix = `${namespace}${key}`;
        core.debug("Key: " + JSON.stringify(key));
        core.debug("Restore keys: " + JSON.stringify(restoreKeys));
        core.debug(`Finding exact match for: ${key}`);
        const keyMatches = yield listObjects(mc, bucket, exactPrefix);
        core.debug(`Found ${JSON.stringify(keyMatches, null, 2)}`);
        if (keyMatches.length > 0) {
            // S3 keys use '/', regardless of the runner OS. Also accept objects saved by
            // older Windows actions on endpoints that preserve their backslash keys.
            const exactMatch = keyMatches.find((obj) => {
                var _a, _b;
                return ((_a = obj.name) === null || _a === void 0 ? void 0 : _a.startsWith(`${exactPrefix}/`)) ||
                    ((_b = obj.name) === null || _b === void 0 ? void 0 : _b.startsWith(`${exactPrefix}\\`));
            });
            if (exactMatch) {
                const result = { item: exactMatch, matchingKey: key };
                core.debug(`Found an exact match; using ${JSON.stringify(result)}`);
                return result;
            }
        }
        core.debug(`Didn't find an exact match`);
        for (const restoreKey of restoreKeys) {
            core.debug(`Finding object with prefix: ${restoreKey}`);
            let objects = yield listObjects(mc, bucket, `${namespace}${restoreKey}`);
            // Accept objects from either era: a runner without zstd writes cache.tgz, and
            // the decompressor is picked from the object name after download.
            objects = objects.filter((o) => o.name !== undefined &&
                compressionMethodForArchive(o.name) !== undefined);
            core.debug(`Found ${JSON.stringify(objects, null, 2)}`);
            if (objects.length < 1) {
                continue;
            }
            const sorted = objects.sort((a, b) => { var _a, _b, _c, _d; return ((_b = (_a = b.lastModified) === null || _a === void 0 ? void 0 : _a.getTime()) !== null && _b !== void 0 ? _b : 0) - ((_d = (_c = a.lastModified) === null || _c === void 0 ? void 0 : _c.getTime()) !== null && _d !== void 0 ? _d : 0); });
            const result = { item: sorted[0], matchingKey: restoreKey };
            core.debug(`Using latest ${JSON.stringify(result)}`);
            return result;
        }
        throw new CacheItemNotFoundError();
    });
}
/**
 * Download and extract the cache object matching the requested keys.
 *
 * Returns undefined when no object matches. S3 failures (unreachable endpoint,
 * missing permissions, corrupted archive, ...) throw, so a caller can tell a
 * miss apart from a broken backend. The caller owns any fallback behaviour.
 */
function restoreFromS3(config, options) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const mc = createS3Client(config);
        // The local compression setting only decides which archive name to prefer
        // while looking the object up; the object name decides how it is extracted.
        const preferredCompressionMethod = yield resolveCompressionMethod({
            requested: options.compression,
            reportFallback: false,
        });
        const archiveFolder = yield cacheUtils.createTempDirectory();
        let found;
        try {
            found = yield findObject(mc, config.bucket, options.key, (_a = options.restoreKeys) !== null && _a !== void 0 ? _a : [], config.prefix);
        }
        catch (error) {
            if (error instanceof CacheItemNotFoundError) {
                core.info(`Cache miss for key ${options.key} in s3. Bucket: ${config.bucket}`);
                return undefined;
            }
            throw error;
        }
        const { item: obj, matchingKey } = found;
        core.debug("found cache object");
        // Cached objects may have been written by a runner with a different
        // compression setup than this one, so trust the object name over the local
        // environment and stay able to restore older gzip archives.
        const archiveName = path_1.default.posix.basename((_b = obj.name) !== null && _b !== void 0 ? _b : "");
        const compressionMethod = (_c = compressionMethodForArchive(archiveName)) !== null && _c !== void 0 ? _c : preferredCompressionMethod;
        const archivePath = path_1.default.join(archiveFolder, cacheUtils.getCacheFileName(compressionMethod));
        if (compressionMethod !== preferredCompressionMethod) {
            core.info(`Cache object ${archiveName} uses ${compressionMethod} compression (local default: ${preferredCompressionMethod}).`);
        }
        const result = {
            matchedKey: matchingKey,
            size: (_d = obj.size) !== null && _d !== void 0 ? _d : 0,
            exactMatch: matchingKey === options.key,
        };
        if (options.lookupOnly) {
            if (result.exactMatch && result.size > 0) {
                core.info(`Cache Hit. NOT Downloading cache from s3 because lookup-only is set. bucket: ${config.bucket}, object: ${obj.name}`);
            }
            else {
                core.info(`Cache Miss or cache size is 0. NOT Downloading cache from s3 because lookup-only is set. bucket: ${config.bucket}, object: ${obj.name}`);
            }
            return result;
        }
        core.info(`Downloading cache from s3 to ${archivePath}. bucket: ${config.bucket}, object: ${obj.name}`);
        yield withRetry(config, "fGetObject", () => mc.fGetObject(config.bucket, obj.name, archivePath));
        if (core.isDebug()) {
            yield (0, tar_1.listTar)(archivePath, compressionMethod);
        }
        core.info(`Cache Size: ${formatSize(result.size)} (${result.size} bytes)`);
        yield (0, tar_1.extractTar)(archivePath, compressionMethod);
        core.info("Cache restored from s3 successfully");
        return result;
    });
}
/**
 * Archive the given paths and upload them as one cache object.
 *
 * Throws on any failure, including upload errors. The caller owns any fallback
 * behaviour.
 */
function saveToS3(config, options) {
    return __awaiter(this, void 0, void 0, function* () {
        const mc = createS3Client(config);
        const compressionMethod = yield resolveCompressionMethod({
            requested: options.compression,
        });
        const cachePaths = yield cacheUtils.resolvePaths(options.paths);
        core.debug("Cache Paths:");
        core.debug(`${JSON.stringify(cachePaths)}`);
        const archiveFolder = yield cacheUtils.createTempDirectory();
        const cacheFileName = cacheUtils.getCacheFileName(compressionMethod);
        const archivePath = path_1.default.join(archiveFolder, cacheFileName);
        core.debug(`Archive Path: ${archivePath}`);
        core.info(`Creating cache archive ${cacheFileName} (compression: ${compressionMethod})`);
        const archiveStartedAt = Date.now();
        yield (0, tar_1.createTar)(archiveFolder, cachePaths, compressionMethod);
        const archiveSeconds = ((Date.now() - archiveStartedAt) /
            MillisecondsPerSecond).toFixed(1);
        core.info(`Cache archive created in ${archiveSeconds}s: ${cacheFileName}, ${formatSize(cacheUtils.getArchiveFileSizeInBytes(archivePath))} (compression: ${compressionMethod})`);
        if (core.isDebug()) {
            yield (0, tar_1.listTar)(archivePath, compressionMethod);
        }
        const object = objectKey(config, options.key, cacheFileName);
        core.info(`Uploading tar to s3. Bucket: ${config.bucket}, Object: ${object}`);
        yield withRetry(config, "fPutObject", () => mc.fPutObject(config.bucket, object, archivePath, {}));
        core.info("Cache saved to s3 successfully");
    });
}
