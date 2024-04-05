const ConfigUtils = require('./config_utils');


/**
 * @final
 * @export
 */
class PlayerConfiguration {
  /**
   * @return {shaka.extern.PlayerConfiguration}
   * @export
   */
  static createDefault() {
    // This is a relatively safe default in the absence of clues from the
    // browser.  For slower connections, the default estimate may be too high.
    const bandwidthEstimate = 1e6; // 1Mbps
    let multiTypeVariantsAllowed = false;
    let abrMaxHeight = Infinity;

    const manifest = {
      availabilityWindowOverride: NaN,
      disableAudio: false,
      disableVideo: false,
      disableText: false,
      disableThumbnails: false,
      defaultPresentationDelay: 0,
      segmentRelativeVttTiming: false,
      raiseFatalErrorOnManifestUpdateRequestFailure: false,
      dash: {
        clockSyncUri: '',
        ignoreDrmInfo: false,
        disableXlinkProcessing: false,
        xlinkFailGracefully: false,
        ignoreMinBufferTime: false,
        autoCorrectDrift: true,
        initialSegmentLimit: 1000,
        ignoreSuggestedPresentationDelay: false,
        ignoreEmptyAdaptationSet: false,
        ignoreMaxSegmentDuration: false,
        keySystemsByURI: {
          'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b':
            'org.w3.clearkey',
          'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e':
            'org.w3.clearkey',
          'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed':
            'com.widevine.alpha',
          'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95':
            'com.microsoft.playready',
          'urn:uuid:79f0049a-4098-8642-ab92-e65be0885f95':
            'com.microsoft.playready',
        },
        manifestPreprocessor: (element) => {
          return shaka.util.ConfigUtils.referenceParametersAndReturn(
              [element],
              element);
        },
        sequenceMode: false,
        enableAudioGroups: false,
        multiTypeVariantsAllowed,
        useStreamOnceInPeriodFlattening: false,
      },
      hls: {
        ignoreTextStreamFailures: false,
        ignoreImageStreamFailures: false,
        defaultAudioCodec: 'mp4a.40.2',
        defaultVideoCodec: 'avc1.42E01E',
        ignoreManifestProgramDateTime: false,
        mediaPlaylistFullMimeType:
            'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"',
        useSafariBehaviorForLive: true,
        liveSegmentsDelay: 3,
        sequenceMode: true,
        ignoreManifestTimestampsInSegmentsMode: false,
        disableCodecGuessing: false,
        allowLowLatencyByteRangeOptimization: true,
      },
      mss: {
        manifestPreprocessor: (element) => {
          return ConfigUtils.referenceParametersAndReturn(
              [element],
              element);
        },
        sequenceMode: false,
        keySystemsBySystemId: {
          '9a04f079-9840-4286-ab92-e65be0885f95':
            'com.microsoft.playready',
          '79f0049a-4098-8642-ab92-e65be0885f95':
            'com.microsoft.playready',
        },
      },
    };

    const abr = {
      enabled: true,
      useNetworkInformation: true,
      defaultBandwidthEstimate: bandwidthEstimate,
      switchInterval: 8,
      bandwidthUpgradeTarget: 0.85,
      bandwidthDowngradeTarget: 0.95,
      restrictions: {
        minWidth: 0,
        maxWidth: Infinity,
        minHeight: 0,
        maxHeight: abrMaxHeight,
        minPixels: 0,
        maxPixels: Infinity,
        minFrameRate: 0,
        maxFrameRate: Infinity,
        minBandwidth: 0,
        maxBandwidth: Infinity,
      },
      advanced: {
        minTotalBytes: 128e3,
        minBytes: 16e3,
        fastHalfLife: 2,
        slowHalfLife: 5,
      },
      restrictToElementSize: false,
      restrictToScreenSize: false,
      ignoreDevicePixelRatio: false,
      clearBufferSwitch: false,
      safeMarginSwitch: 0,
    };

    const cmcd = {
      enabled: false,
      sessionId: '',
      contentId: '',
      rtpSafetyFactor: 5,
      useHeaders: false,
      includeKeys: [],
    };

    const cmsd = {
      enabled: true,
      applyMaximumSuggestedBitrate: true,
      estimatedThroughputWeightRatio: 0.5,
    };

    const lcevc = {
      enabled: false,
      dynamicPerformanceScaling: true,
      logLevel: 0,
      drawLogo: false,
    };

    const mediaSource = {
      sourceBufferExtraFeatures: '',
      forceTransmux: false,
      insertFakeEncryptionInInit: true,
      modifyCueCallback: (cue, uri) => {
        return ConfigUtils.referenceParametersAndReturn(
            [cue, uri],
            undefined);
      },
    };

    const ads = {
      customPlayheadTracker: false,
    };

    /** @type {shaka.extern.PlayerConfiguration} */
    const config = {
      manifest: manifest,
      mediaSource: mediaSource,
      abr: abr,
      autoShowText: 3,
      preferredAudioLanguage: '',
      preferredAudioLabel: '',
      preferredTextLanguage: '',
      preferredVariantRole: '',
      preferredTextRole: '',
      preferredAudioChannelCount: 2,
      preferredVideoHdrLevel: 'AUTO',
      preferredVideoLayout: '',
      preferredVideoLabel: '',
      preferredVideoCodecs: [],
      preferredAudioCodecs: [],
      preferForcedSubs: false,
      preferSpatialAudio: false,
      preferredDecodingAttributes: [],
      restrictions: {
        minWidth: 0,
        maxWidth: Infinity,
        minHeight: 0,
        maxHeight: Infinity,
        minPixels: 0,
        maxPixels: Infinity,
        minFrameRate: 0,
        maxFrameRate: Infinity,
        minBandwidth: 0,
        maxBandwidth: Infinity,
      },
      playRangeStart: 0,
      playRangeEnd: Infinity,
      textDisplayFactory: () => null,
      cmcd: cmcd,
      cmsd: cmsd,
      lcevc: lcevc,
      ads: ads,
    };

    return config;
  }
};

module.exports = PlayerConfiguration;