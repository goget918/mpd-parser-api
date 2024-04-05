const { URL } = require('url'); // Using Node.js built-in module for URL manipulation
const ManifestParserUtils = require('./manifest_parser_utils');

class ContentSteeringManager {
  constructor(playerInterface) {
    /** @private {?shaka.extern.ManifestConfiguration} */
    this.config_ = null;

    /** @private {?shaka.extern.ManifestParser.PlayerInterface} */
    this.playerInterface_ = playerInterface;

    // /** @private {!shaka.util.OperationManager} */
    // this.operationManager_ = new shaka.util.OperationManager();

    /** @private {!Array.<string>} */
    this.baseUris_ = [];

    /** @private {?string} */
    this.defaultPathwayId_ = null;

    /** @private {!Array.<string>} */
    this.pathwayPriority_ = [];

    /** @private {?string} */
    this.lastPathwayUsed_ = null;

    /** @private {!Array.<shaka.util.ContentSteeringManager.PathawayClone>} */
    this.pathwayClones_ = [];

    /**
     * Default to 5 minutes. Value in seconds.
     *
     * @private {number}
     */
    this.lastTTL_ = 300;

    /** @private {!Map.<(string|number), !Map.<string, string>>} */
    this.locations_ = new Map();

    /** @private {!Map.<string, number>} */
    this.bannedLocations_ = new Map();

    /** @private {?shaka.util.Timer} */
    this.updateTimer_ = null;

    /** @private {string} */
    this.manifestType_ = 'unknown';
  }

  configure(config) {
    this.config = config;
  }

  destroy() {
    // Implement destroy logic
  }

  setManifestType(manifestType) {
    this.manifestType = manifestType;
  }

  setBaseUris(baseUris) {
    this.baseUris = baseUris;
  }

  setDefaultPathwayId(defaultPathwayId) {
    this.defaultPathwayId = defaultPathwayId;
  }

  async requestInfo(uri) {
    // Implement requestInfo logic
  }

  addQueryParams(uri) {
    // Implement addQueryParams logic
  }

  processManifest(manifest, finalManifestUri) {
    // Implement processManifest logic
  }

  clearPreviousLocations() {
    this.locations.clear();
  }

  /**
   * @param {string|number} streamId
   * @param {string} pathwayId
   * @param {string} uri
   */
  addLocation(streamId, pathwayId, uri) {
    let streamLocations = this.locations_.get(streamId);
    if (!streamLocations) {
      streamLocations = new Map();
    }
    streamLocations.set(pathwayId, uri);
    this.locations_.set(streamId, streamLocations);
  }

  banLocation(uri) {
    const bannedUntil = Date.now() + 60000;
    this.bannedLocations_.set(uri, bannedUntil);
  }

    /**
   * Get the base locations ordered according the priority.
   *
   * @param {string|number} streamId
   * @param {boolean=} ignoreBaseUrls
   * @return {!Array.<string>}
   */
    getLocations(streamId, ignoreBaseUrls = false) {
      const streamLocations = this.locations_.get(streamId) || new Map();
      /** @type {!Array.<!{pathwayId: string, location: string}>} */
      let locationsPathwayIdMap = [];
      for (const pathwayId of this.pathwayPriority_) {
        const location = streamLocations.get(pathwayId);
        if (location) {
          locationsPathwayIdMap.push({pathwayId, location});
        } else {
          const clone = this.pathwayClones_.find((c) => c.ID == pathwayId);
          if (clone) {
            const cloneLocation = streamLocations.get(clone['BASE-ID']);
            if (cloneLocation) {
              if (clone['URI-REPLACEMENT'].HOST) {
                const uri = new goog.Uri(cloneLocation);
                uri.setDomain(clone['URI-REPLACEMENT'].HOST);
                locationsPathwayIdMap.push({
                  pathwayId: pathwayId,
                  location: uri.toString(),
                });
              } else {
                locationsPathwayIdMap.push({
                  pathwayId: pathwayId,
                  location: cloneLocation,
                });
              }
            }
          }
        }
      }
  
      const now = Date.now();
      for (const uri of this.bannedLocations_.keys()) {
        const bannedUntil = this.bannedLocations_.get(uri);
        if (now > bannedUntil) {
          this.bannedLocations_.delete(uri);
        }
      }
      locationsPathwayIdMap = locationsPathwayIdMap.filter((l) => {
        for (const uri of this.bannedLocations_.keys()) {
          if (uri.includes(new goog.Uri(l.location).getDomain())) {
            return false;
          }
        }
        return true;
      });
  
      if (locationsPathwayIdMap.length) {
        this.lastPathwayUsed_ = locationsPathwayIdMap[0].pathwayId;
      }
  
      const locations = locationsPathwayIdMap.map((l) => l.location);
  
      if (!locations.length && this.defaultPathwayId_) {
        for (const pathwayId of this.defaultPathwayId_.split(',')) {
          const location = streamLocations.get(pathwayId);
          if (location) {
            this.lastPathwayUsed_ = this.defaultPathwayId_;
            locations.push(location);
          }
        }
      }
      if (!locations.length) {
        for (const location of streamLocations.values()) {
          locations.push(location);
        }
      }
      if (ignoreBaseUrls) {
        return locations;
      }
      return ManifestParserUtils.resolveUris(
          this.baseUris_, locations);
    }
}

module.exports = ContentSteeringManager;
