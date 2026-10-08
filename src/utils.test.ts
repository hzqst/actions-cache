import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as core from "@actions/core";
import * as minio from "minio";
import path from "path";
import { Readable } from "stream";
import {
  CompressionInput,
  compressionMethodForArchive,
  findObject,
  resolveCompressionMethod,
  saveCache,
} from "./utils";
import { State } from "./state";

jest.mock("@actions/core");
jest.mock("@actions/cache");
jest.mock("@actions/cache/lib/internal/cacheUtils");
jest.mock("@actions/cache/lib/internal/tar");
jest.mock("minio");
jest.mock("p-retry", () => ({ __esModule: true, default: (fn: () => unknown) => fn() }));
// Use an isolated path object so platform simulation cannot affect Jest itself.
jest.mock("path", () => ({ ...jest.requireActual("path") }));

describe.each(["win32", "posix"] as const)("S3 object paths on %s", (platform) => {
  const key = "cache-key";
  const bucket = "cache-bucket";
  let listObjectsV2: jest.Mock;
  let fPutObject: jest.Mock;
  let mc: minio.Client;

  beforeEach(() => {
    path.join = path[platform].join;
    Object.defineProperty(path, "sep", { value: path[platform].sep, configurable: true });
    listObjectsV2 = jest.fn();
    fPutObject = jest.fn().mockResolvedValue({});
    mc = { listObjectsV2, fPutObject } as unknown as minio.Client;
    jest.mocked(minio.Client).mockImplementation(() => mc);
    jest.mocked(core.getInput).mockImplementation((name) => ({
      bucket, key, path: "payload", "use-fallback": "false", compression: "gzip",
    }[name] || ""));
    jest.mocked(core.getState).mockReturnValue("");
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.Gzip);
    jest.mocked(cacheUtils.getCacheFileName).mockImplementation((method) =>
      method === CompressionMethod.Gzip ? "cache.tgz" : "cache.tzst"
    );
    jest.mocked(cacheUtils.createTempDirectory).mockResolvedValue("temporary");
    jest.mocked(cacheUtils.resolvePaths).mockResolvedValue(["payload"]);
    jest.mocked(cacheUtils.getArchiveFileSizeInBytes).mockReturnValue(42);
  });

  test.each(["/", "\\"])("restores an exact object using %s, including legacy Windows keys", async (separator) => {
    const object = { name: `${key}${separator}cache.tgz`, size: 42 };
    listObjectsV2.mockImplementation(() => Readable.from([object]));
    const got = await findObject(mc, bucket, key, []);
    expect(got).toEqual({ item: object, matchingKey: key });
    expect(listObjectsV2).toHaveBeenCalledWith(bucket, key, true);
  });

  test("restores a zstd exact object written by another runner", async () => {
    const object = { name: `${key}/cache.tzst`, size: 42 };
    listObjectsV2.mockImplementation(() => Readable.from([object]));
    await expect(findObject(mc, bucket, key, [])).resolves.toEqual({ item: object, matchingKey: key });
  });

  test("does not confuse a longer key with an exact hit", async () => {
    listObjectsV2.mockImplementation(() => Readable.from([{ name: `${key}-other/cache.tgz` }]));
    await expect(findObject(mc, bucket, key, [])).rejects.toThrow("Cache item not found");
  });

  test("keeps newest-prefix discovery after an exact miss", async () => {
    const older = { name: "prefix-old/cache.tgz", lastModified: new Date(1), size: 10 };
    const newer = { name: "prefix-new/cache.tzst", lastModified: new Date(2), size: 20 };
    listObjectsV2.mockImplementation((_bucket, prefix) =>
      Readable.from(prefix === key ? [] : [older, newer])
    );
    const got = await findObject(mc, bucket, key, ["prefix-"]);
    expect(got).toEqual({ item: newer, matchingKey: "prefix-" });
  });

  test("ignores prefix objects that are not cache archives", async () => {
    listObjectsV2.mockImplementation((_bucket, prefix) =>
      Readable.from(prefix === key ? [] : [{ name: "prefix-other/notes.txt", lastModified: new Date(2) }])
    );
    await expect(findObject(mc, bucket, key, ["prefix-"])).rejects.toThrow("Cache item not found");
  });

  test.each([true, false])("saves a portable object and a native archive path (standalone=%s)", async (standalone) => {
    jest.mocked(core.getState).mockImplementation((name) => ({
      [State.PrimaryKey]: key,
    }[name] || ""));
    await saveCache(standalone);
    expect(fPutObject).toHaveBeenCalledWith(
      bucket, `${key}/cache.tgz`, path[platform].join("temporary", "cache.tgz"), {}
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  test("preserves slash-separated input keys during upload", async () => {
    jest.mocked(core.getInput).mockImplementation((name) => ({
      bucket, key: "namespace/cache-key", path: "payload",
    }[name] || ""));
    await saveCache(true);
    expect(fPutObject).toHaveBeenCalledWith(
      bucket, "namespace/cache-key/cache.tgz", path[platform].join("temporary", "cache.tgz"), {}
    );
  });

  test("saves a zstd archive when zstd is available", async () => {
    jest.mocked(core.getInput).mockImplementation((name) => ({
      bucket, key, path: "payload", "use-fallback": "false", compression: "auto",
    }[name] || ""));
    jest.mocked(core.getState).mockImplementation((name) => ({
      [State.PrimaryKey]: key,
    }[name] || ""));
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.ZstdWithoutLong);
    await saveCache(true);
    expect(fPutObject).toHaveBeenCalledWith(
      bucket, `${key}/cache.tzst`, path[platform].join("temporary", "cache.tzst"), {}
    );
    expect(core.warning).not.toHaveBeenCalled();
  });
});

describe("compression", () => {
  beforeEach(() => {
    jest.mocked(cacheUtils.getCacheFileName).mockImplementation((method) =>
      method === CompressionMethod.Gzip ? "cache.tgz" : "cache.tzst"
    );
  });

  test.each([
    ["cache.tzst", CompressionMethod.ZstdWithoutLong],
    ["cache-key/cache.tgz", CompressionMethod.Gzip],
  ])("identifies %s", (archiveName, expected) => {
    expect(compressionMethodForArchive(archiveName)).toBe(expected);
  });

  test("does not identify a non archive name", () => {
    expect(compressionMethodForArchive("cache-key/notes.txt")).toBeUndefined();
  });

  test("auto keeps zstd when zstd is on PATH", async () => {
    jest.mocked(core.getInput).mockReturnValue(CompressionInput.Auto);
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.ZstdWithoutLong);
    await expect(resolveCompressionMethod()).resolves.toBe(CompressionMethod.ZstdWithoutLong);
    expect(core.warning).not.toHaveBeenCalled();
  });

  test("auto reports the gzip fallback", async () => {
    jest.mocked(core.getInput).mockReturnValue(CompressionInput.Auto);
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.Gzip);
    await expect(resolveCompressionMethod()).resolves.toBe(CompressionMethod.Gzip);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("zstd is not on PATH"));
  });

  test("treats a missing input as auto", async () => {
    jest.mocked(core.getInput).mockReturnValue("");
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.ZstdWithoutLong);
    await expect(resolveCompressionMethod()).resolves.toBe(CompressionMethod.ZstdWithoutLong);
    expect(core.warning).not.toHaveBeenCalled();
  });

  test("skips the zstd probe when gzip is requested", async () => {
    jest.mocked(core.getInput).mockReturnValue(CompressionInput.Gzip);
    await expect(resolveCompressionMethod()).resolves.toBe(CompressionMethod.Gzip);
    expect(cacheUtils.getCompressionMethod).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  test("falls back to gzip when zstd is requested but missing", async () => {
    jest.mocked(core.getInput).mockReturnValue(CompressionInput.Zstd);
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.Gzip);
    await expect(resolveCompressionMethod()).resolves.toBe(CompressionMethod.Gzip);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("requested, but zstd is not on PATH"));
  });

  test("reports an unknown value and behaves as auto", async () => {
    jest.mocked(core.getInput).mockReturnValue("lz4");
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.ZstdWithoutLong);
    await expect(resolveCompressionMethod()).resolves.toBe(CompressionMethod.ZstdWithoutLong);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Unknown compression "lz4"'));
  });

  test.each([CompressionInput.Auto, CompressionInput.Zstd])(
    "stays quiet about the gzip fallback when a restore resolves %s",
    async (input) => {
      jest.mocked(core.getInput).mockReturnValue(input);
      jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.Gzip);
      await expect(
        resolveCompressionMethod({ reportFallback: false })
      ).resolves.toBe(CompressionMethod.Gzip);
      expect(core.warning).not.toHaveBeenCalled();
    }
  );
});
