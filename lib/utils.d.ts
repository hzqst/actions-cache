import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as core from "@actions/core";
import * as minio from "minio";
import { CacheItemNotFoundError, CompressionInput, compressionMethodForArchive, createS3Client, findObject, formatSize, listObjects, restoreFromS3, type S3CacheConfig, type SaveOptions, saveToS3, withRetry } from "./s3";
export { CacheItemNotFoundError, CompressionInput, compressionMethodForArchive, createS3Client, findObject, formatSize, listObjects, restoreFromS3, saveToS3, withRetry, };
export type { S3CacheConfig, SaveOptions };
export declare function isGhes(): boolean;
export declare function getInput(key: string, envKey?: string): string;
export type S3CredentialOverrides = Pick<S3CacheConfig, "accessKey" | "secretKey" | "sessionToken" | "region">;
/**
 * S3 configuration from the action inputs. `overrides` exist because inputs are
 * re-evaluated before the post action, so it passes the values captured during
 * the restore instead.
 */
export declare function s3ConfigFromInputs(overrides?: Partial<S3CredentialOverrides>): S3CacheConfig;
export declare function newMinio(overrides?: S3CredentialOverrides): minio.Client;
export declare function getInputAsBoolean(name: string, options?: core.InputOptions): boolean;
export declare function getInputAsArray(name: string, options?: core.InputOptions): string[];
export declare function getInputAsInt(name: string, options?: core.InputOptions): number | undefined;
/** Compression method for new archives, from the `compression` input. */
export declare function resolveCompressionMethod({ reportFallback }?: {
    reportFallback?: boolean;
}): Promise<CompressionMethod>;
export declare function setCacheHitOutput(isCacheHit: boolean): void;
export declare function setCacheSizeOutput(cacheSize: number): void;
export declare function setCacheMatchedKeyOutput(cacheMatchedKey: string): void;
export declare function saveMatchedKey(matchedKey: string): void;
export declare function isExactKeyMatch(): boolean;
export declare function saveCache(standalone: boolean): Promise<void>;
