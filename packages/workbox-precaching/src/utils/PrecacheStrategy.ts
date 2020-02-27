/*
  Copyright 2020 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import {copyResponse} from 'workbox-core/copyResponse.js';
import {getFriendlyURL} from 'workbox-core/_private/getFriendlyURL.js';
import {logger} from 'workbox-core/_private/logger.js';
import {WorkboxError} from 'workbox-core/_private/WorkboxError.js';
import {WorkboxPluginCallbackParam} from 'workbox-core/types.js';
import {Strategy, StrategyOptions} from 'workbox-strategies/Strategy.js';
import {StrategyHandler} from 'workbox-strategies/StrategyHandler.js';

import '../_version.js';


async function copyRedirectedResponses({response}: WorkboxPluginCallbackParam['cacheWillUpdate']) {
  return response.redirected ? await copyResponse(response) : response;
}


class PrecacheStrategy extends Strategy {
  constructor(options: StrategyOptions) {
    super(options);

    // Redirected responses cannot be used to satisfy a navigation request, so
    // any redirected response must be "copied" rather than cloned, so the new
    // response doesn't contain the `redirected` flag. See:
    // https://bugs.chromium.org/p/chromium/issues/detail?id=669363&desc=2#c1
    this.plugins.push({cacheWillUpdate: copyRedirectedResponses});
  }

  _handle(request: Request, handler: StrategyHandler) {
    // If this is an `install` event then populate the cache. If this is a
    // `fetch` event (or any other event) then respond with the cached response.
    if (handler.event && handler.event.type === 'install') {
      return this._handleInstall(request, handler);
    }
    return this._handleFetch(request, handler);
  }

  async _handleFetch(request: Request, handler: StrategyHandler) {
    let response = await handler.cacheMatch(request);

    if (!response) {
      // Fall back to the network if we don't have a cached response
      // (perhaps due to manual cache cleanup).
      if (handler.params &&
          handler.params.fallbackToNetwork === false) {
        // This shouldn't normally happen, but there are edge cases:
        // https://github.com/GoogleChrome/workbox/issues/1441
        throw new WorkboxError('missing-precache-entry', {
          cacheName: this.cacheName,
          url: request.url,
        });
      } else {
        if (process.env.NODE_ENV !== 'production') {
          logger.warn(`The precached response for ` +
              `${getFriendlyURL(request.url)} in ${this.cacheName} was not ` +
              `found. Falling back to the network instead.`);
        }
        response = await handler.fetch(request);
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      // Workbox is going to handle the route.
      // print the routing details to the console.
      logger.groupCollapsed(`Precaching is responding to: ` +
          getFriendlyURL(request.url));
      logger.log(`Serving the precached url: ` +
          handler.params.cacheKey);

      logger.groupCollapsed(`View request details here.`);
      logger.log(request);
      logger.groupEnd();

      logger.groupCollapsed(`View response details here.`);
      logger.log(response);
      logger.groupEnd();

      logger.groupEnd();
    }
    return response;
  }

  async _handleInstall(request: Request, handler: StrategyHandler) {
    const response = await handler.fetchAndCachePut(request);

    // Any time there's no response, consider it a precaching error.
    let responseSafeToPrecache = Boolean(response);

    // Also consider it an error if the user didn't pass their own
    // cacheWillUpdate plugin, and the response is a 400+ (note: this means
    // that by default opaque responses can be precached).
    if (response && response.status >= 400 &&
        !this._usesCustomCacheableResponseLogic()) {
      responseSafeToPrecache = false;
    }

    if (!responseSafeToPrecache) {
      // Throwing here will lead to the `install` handler failing, which
      // we want to do if *any* of the responses aren't safe to cache.
      throw new WorkboxError('bad-precaching-response', {
        url: request.url,
        status: response.status,
      });
    }

    return response;
  }

  /**
   * Returns true if any users plugins were added containing their own
   * `cacheWillUpdate` callback.
   *
   * This method indicates whether the default cacheable response logic (i.e.
   * <400, including opaque responses) should be used. If a custom plugin
   * with a `cacheWillUpdate` callback is passed, then the strategy should
   * defer to that plugin's logic.
   *
   * @private
   */
  _usesCustomCacheableResponseLogic(): boolean {
    for (const plugin of this.plugins) {
      if (plugin.cacheWillUpdate &&
          plugin.cacheWillUpdate !== copyRedirectedResponses) {
        return true;
      }
    }
    return false;
  }
}

export {PrecacheStrategy};
