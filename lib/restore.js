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
const cache = __importStar(require("@actions/cache"));
const core = __importStar(require("@actions/core"));
const state_1 = require("./state");
const utils_1 = require("./utils");
process.on("uncaughtException", (e) => core.info("warning: " + e.message));
function restoreCache() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const bucket = core.getInput("bucket", { required: true });
            const key = core.getInput("key", { required: true });
            const useFallback = (0, utils_1.getInputAsBoolean)("use-fallback");
            const paths = (0, utils_1.getInputAsArray)("path");
            const restoreKeys = (0, utils_1.getInputAsArray)("restore-keys");
            const lookupOnly = (0, utils_1.getInputAsBoolean)("lookup-only");
            let restoredFromS3 = false;
            try {
                // Inputs are re-evaluted before the post action, so we want to store the original values
                core.saveState(state_1.State.PrimaryKey, key);
                core.saveState(state_1.State.AccessKey, (0, utils_1.getInput)("accessKey", "AWS_ACCESS_KEY_ID"));
                core.saveState(state_1.State.SecretKey, (0, utils_1.getInput)("secretKey", "AWS_SECRET_ACCESS_KEY"));
                core.saveState(state_1.State.SessionToken, (0, utils_1.getInput)("sessionToken", "AWS_SESSION_TOKEN"));
                core.saveState(state_1.State.Region, (0, utils_1.getInput)("region", "AWS_REGION"));
                const config = (0, utils_1.s3ConfigFromInputs)();
                config.bucket = bucket;
                const result = yield (0, utils_1.restoreFromS3)(config, {
                    key,
                    paths,
                    restoreKeys,
                    lookupOnly,
                    compression: (0, utils_1.getInput)("compression"),
                });
                if (result !== undefined) {
                    (0, utils_1.saveMatchedKey)(result.matchedKey);
                    (0, utils_1.setCacheHitOutput)(result.exactMatch);
                    (0, utils_1.setCacheSizeOutput)(result.size);
                    (0, utils_1.setCacheMatchedKeyOutput)(result.matchedKey);
                    restoredFromS3 = true;
                }
            }
            catch (e) {
                core.info("Restore s3 cache failed: " + e.message);
            }
            if (restoredFromS3) {
                return;
            }
            // A miss and a broken backend both end up here: the GitHub cache may still
            // hold a usable entry, so it stays in play when a fallback was requested.
            (0, utils_1.setCacheHitOutput)(false);
            (0, utils_1.setCacheMatchedKeyOutput)("");
            if (!useFallback) {
                core.info(`No cache restored from s3 for key: ${key}`);
                return;
            }
            if ((0, utils_1.isGhes)()) {
                core.warning("Cache fallback is not supported on Github Enterpise.");
                return;
            }
            core.info("Restore cache using fallback cache");
            const fallbackMatchingKey = yield cache.restoreCache(paths, key, restoreKeys);
            if (fallbackMatchingKey) {
                (0, utils_1.saveMatchedKey)(fallbackMatchingKey);
                (0, utils_1.setCacheHitOutput)(fallbackMatchingKey === key);
                (0, utils_1.setCacheMatchedKeyOutput)(fallbackMatchingKey);
                core.info("Fallback cache restored successfully");
            }
            else {
                core.info("Fallback cache restore failed");
            }
        }
        catch (e) {
            core.setFailed(e.message);
        }
    });
}
restoreCache();
