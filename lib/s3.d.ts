import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as minio from "minio";
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
export declare class CacheItemNotFoundError extends Error {
    constructor();
}
export declare const CompressionInput: {
    readonly Auto: "auto";
    readonly Zstd: "zstd";
    readonly Gzip: "gzip";
};
/**
 * Compression method that produced `archiveName`, or undefined when the name
 * carries neither known archive suffix.
 */
export declare function compressionMethodForArchive(archiveName: string): CompressionMethod | undefined;
export declare function createS3Client(config: S3CacheConfig): minio.Client;
export declare function withRetry<A>(config: Pick<S3CacheConfig, "retry" | "retryCount">, name: string, fn: () => Promise<A>): Promise<A>;
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
export declare function resolveCompressionMethod({ requested, reportFallback, }?: {
    requested?: string;
    reportFallback?: boolean;
}): Promise<CompressionMethod>;
export declare function formatSize(value?: number, format?: string): string;
/**
 * Object key of an archive. S3 keys use "/", regardless of the runner OS.
 */
export declare function objectKey(config: Pick<S3CacheConfig, "prefix">, key: string, archiveName: string): string;
export declare function listObjects(mc: minio.Client, bucket: string, prefix: string): Promise<minio.BucketItem[]>;
export type FindObjectResult = {
    item: minio.BucketItem;
    matchingKey: string;
};
/**
 * Object matching `key` exactly, or the newest object carrying one of the
 * `restoreKeys` prefixes. Throws CacheItemNotFoundError when nothing matches.
 */
export declare function findObject(mc: minio.Client, bucket: string, key: string, restoreKeys: string[], prefix?: string): Promise<FindObjectResult>;
/**
 * Download and extract the cache object matching the requested keys.
 *
 * Returns undefined when no object matches. S3 failures (unreachable endpoint,
 * missing permissions, corrupted archive, ...) throw, so a caller can tell a
 * miss apart from a broken backend. The caller owns any fallback behaviour.
 */
export declare function restoreFromS3(config: S3CacheConfig, options: RestoreOptions): Promise<RestoreResult | undefined>;
/**
 * Archive the given paths and upload them as one cache object.
 *
 * Throws on any failure, including upload errors. The caller owns any fallback
 * behaviour.
 */
export declare function saveToS3(config: S3CacheConfig, options: SaveOptions): Promise<void>;
