import _ from 'lodash'
import Debug from 'debug'
import { rewriteJsSourceMapAsync } from './async-rewriters'
import * as sourceMaps from './util/source-maps'

const debug = Debug('cypress:rewriter:deferred-source-map-cache')

export type DeferredSourceMapRequest = {
  uniqueId: string
  url: string
  js?: string
  sourceMap?: any
}

/**
 * Holds on to data necessary to rewrite user JS to maybe generate a sourcemap at a later time,
 * potentially composed with the user's own sourcemap if one is present.
 *
 * The purpose of this is to avoid wasting CPU time and network I/O on generating, composing, and
 * sending a sourcemap along with every single rewritten JS snippet, since the source maps are
 * going to be unused and discarded most of the time.
 */
export class DeferredSourceMapCache {
  _idCounter = 0
  requests: DeferredSourceMapRequest[] = []
  requestLib: any

  constructor (requestLib) {
    this.requestLib = requestLib
  }

  reset () {
    this.requests = []
  }

  defer = (request: DeferredSourceMapRequest): string => {
    debug('caching request %o', request)

    if (this._getRequestById(request.uniqueId)) {
      // prevent duplicate uniqueIds from ever existing
      throw new Error(`Deferred sourcemap key "${request.uniqueId}" is not unique`)
    }

    // remove existing requests for this URL since they will not be loaded again
    this._removeRequestsByUrl(request.url)

    this.requests.push(request)

    return request.uniqueId
  }

  _removeRequestsByUrl (url: string) {
    _.remove(this.requests, { url })
  }

  _getRequestById (uniqueId: string) {
    return _.find(this.requests, { uniqueId })
  }

  async resolve (uniqueId: string, headers: any) {
    const request = this._getRequestById(uniqueId)

    if (!request) {
      return
    }

    if (request.sourceMap) {
      return request.sourceMap
    }

    if (!request.js) {
      throw new Error('Missing JS for source map rewrite')
    }

    const sourceMapUrl = sourceMaps.getMappingUrl(request.js)

    let inputSourceMap

    if (sourceMapUrl) {
      // try to decode it as a base64 string
      inputSourceMap = sourceMaps.tryDecodeInlineUrl(sourceMapUrl)

      if (!inputSourceMap) {
        // try to load it from the web
        const req = {
          url: request.url,
          headers,
          timeout: 5000,
        }

        try {
          const { body } = await this.requestLib(req, true)

          inputSourceMap = body
        } catch (error) {
          // eslint-disable-next-line no-console
          debug('got an error loading user-provided sourcemap, serving proxy-generated sourcemap only %o', { url: request.url, headers, error })
        }
      }
    }

    // cache the sourceMap so we don't need to regenerate it
    request.sourceMap = await rewriteJsSourceMapAsync(request.url, request.js, inputSourceMap)
    delete request.js // won't need this again

    return request.sourceMap
  }
}
