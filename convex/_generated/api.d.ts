/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as decide from "../decide.js";
import type * as elevenlabs from "../elevenlabs.js";
import type * as events from "../events.js";
import type * as fallback from "../fallback.js";
import type * as http from "../http.js";
import type * as incidents from "../incidents.js";
import type * as notify from "../notify.js";
import type * as portal from "../portal.js";
import type * as seed from "../seed.js";
import type * as talk from "../talk.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  decide: typeof decide;
  elevenlabs: typeof elevenlabs;
  events: typeof events;
  fallback: typeof fallback;
  http: typeof http;
  incidents: typeof incidents;
  notify: typeof notify;
  portal: typeof portal;
  seed: typeof seed;
  talk: typeof talk;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
