import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as core from "@actions/core";
import * as minio from "minio";
import path from "path";
import { Readable } from "stream";
import { findObject, saveCache } from "./utils";
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
      bucket, key, path: "payload", "use-fallback": "false",
    }[name] || ""));
    jest.mocked(core.getState).mockReturnValue("");
    jest.mocked(cacheUtils.getCompressionMethod).mockResolvedValue(CompressionMethod.Gzip);
    jest.mocked(cacheUtils.getCacheFileName).mockReturnValue("cache.tgz");
    jest.mocked(cacheUtils.createTempDirectory).mockResolvedValue("temporary");
    jest.mocked(cacheUtils.resolvePaths).mockResolvedValue(["payload"]);
  });

  test.each(["/", "\\"])("restores an exact object using %s, including legacy Windows keys", async (separator) => {
    const object = { name: `${key}${separator}cache.tgz`, size: 42 };
    listObjectsV2.mockImplementation(() => Readable.from([object]));
    const got = await findObject(mc, bucket, key, [], CompressionMethod.Gzip);
    expect(got).toEqual({ item: object, matchingKey: key });
    expect(listObjectsV2).toHaveBeenCalledWith(bucket, key, true);
  });

  test("does not confuse a longer key with an exact hit", async () => {
    listObjectsV2.mockImplementation(() => Readable.from([{ name: `${key}-other/cache.tgz` }]));
    await expect(findObject(mc, bucket, key, [], CompressionMethod.Gzip)).rejects.toThrow("Cache item not found");
  });

  test("keeps newest-prefix discovery after an exact miss", async () => {
    const older = { name: "prefix-old/cache.tgz", lastModified: new Date(1), size: 10 };
    const newer = { name: "prefix-new/cache.tgz", lastModified: new Date(2), size: 20 };
    listObjectsV2.mockImplementation((_bucket, prefix) =>
      Readable.from(prefix === key ? [] : [older, newer])
    );
    const got = await findObject(mc, bucket, key, ["prefix-"], CompressionMethod.Gzip);
    expect(got).toEqual({ item: newer, matchingKey: "prefix-" });
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
});
