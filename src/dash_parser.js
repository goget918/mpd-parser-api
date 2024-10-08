const fs = require('fs');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const ManifestParserUtils = require('./util/manifest_parser_utils');
const LanguageUtils = require('./util/language_utils');
const PresentationTimeline = require('./media/presentation_timeline');
const MimeUtils = require('./util/mime_utils');
const SegmentBase = require('./dash/segment_base');
const SegmentTemplate = require('./dash/segment_template');
const SegmentList = require('./dash/segment_list');
const TextEngine = require('./text/text_engine');
const Functional = require('./util/functional');
const xml_utils = require('./util/xml_utils');
const path = require('path');
const assert = require('assert');

const ContentSteeringManager = require('./util/content_steering_manager');
const PeriodCombiner = require('./util/period_combiner');
const logger = require('./util/logger');

class DashMpdParser {
    constructor() {
        this.config_ = null;
        this.playerInterface_ = null;
        this.manifestUri_ = null;
        this.manifest_ = null;
        this.globalId_ = 1;

        /**
         * A map of IDs to Stream objects.
         * ID: Period@id,AdaptationSet@id,@Representation@id
         * e.g.: '1,5,23'
         */
        this.streamMap_ = {};

        /**
         * A map of period ids to their durations
         */
        this.periodDurations_ = {};

        this.periodCombiner_ = new PeriodCombiner();

        /**
         * The update period in seconds, or 0 for no updates.
         */
        this.updatePeriod_ = 0;

        // this.updateTimer_ = new shaka.util.Timer(() => {
        //     this.onUpdate_();
        // });

        //this.operationManager_ = new shaka.util.OperationManager();

        /**
         * Largest period start time seen.
         */
        this.largestPeriodStartTime_ = null;

        /**
         * Period IDs seen in previous manifest.
         */
        this.lastManifestUpdatePeriodIds_ = [];

        /**
         * The minimum of the availabilityTimeOffset values among the adaptation
         * sets.
         */
        this.minTotalAvailabilityTimeOffset_ = Infinity;

        this.lowLatencyMode_ = false;

        /** util/ContentSteeringManager */
        this.contentSteeringManager_ = null;
    }

    configure(config) {
        this.config_ = config;

        if (this.periodCombiner_) {
            this.periodCombiner_.setAllowMultiTypeVariants(
                this.config_.dash.multiTypeVariantsAllowed
                // && shaka.media.Capabilities.isChangeTypeSupported()
            );
            this.periodCombiner_.setUseStreamOnce(
                this.config_.dash.useStreamOnceInPeriodFlattening);
        }
    }

    async start(uri, baseUrl, requestHeader, proxy) {
        // this.lowLatencyMode_ = playerInterface.isLowLatencyMode();
        this.manifestUri_ = uri;

        await this.requestManifest_(baseUrl, requestHeader, proxy);

        return this.manifest_;
    }

    stop() {
        // When the parser stops, release all segment indexes, which stops their
        // timers, as well.
        for (const stream of Object.values(this.streamMap_)) {
            if (stream.segmentIndex) {
                stream.segmentIndex.release();
            }
        }

        if (this.periodCombiner_) {
            this.periodCombiner_.release();
        }

        this.playerInterface_ = null;
        this.config_ = null;
        this.manifestUri_ = [];
        this.manifest_ = null;
        this.streamMap_ = {};
        this.periodCombiner_ = null;

        if (this.updateTimer_ != null) {
            this.updateTimer_.stop();
            this.updateTimer_ = null;
        }

        if (this.contentSteeringManager_) {
            this.contentSteeringManager_.destroy();
        }

        return this.operationManager_.destroy();
    }

    async requestManifest_(baseUrl, requestHeader, proxy) {
        try {
            // Define the request options
            let requestOptions = {
                headers: requestHeader
            };

            // If proxy is set, add the proxy configuration to the request options
            if (proxy) {
                const [protocol, rest] = proxy.split('://');
                if (protocol.startsWith('socks')) {
                    // For SOCKS proxy
                    requestOptions.httpAgent = new SocksProxyAgent(proxy);
                    requestOptions.httpsAgent = new SocksProxyAgent(proxy);
                } else {
                    // For HTTP/HTTPS proxy
                    //Check if there is auth
                    if (rest.includes('@')) {
                        const [auth, address] = rest.split('@');
                        const [user, password] = auth.split(':');
                        const [host, port] = address.split(':');
                        requestOptions.proxy = {
                            protocol: protocol,
                            host: host,
                            port: parseInt(port),
                            auth: {
                                username: user,
                                password: password
                            }
                        };
                    } else {
                        const [host, port] = rest.split(':');
                        requestOptions.proxy = {
                            protocol: protocol,
                            host: host,
                            port: parseInt(port)
                        };
                    }


                }
            }

            const response = await axios.get(this.manifestUri_, requestOptions);
            const mpdBuffer = Buffer.from(response.data);

            await this.parseManifest_(mpdBuffer, baseUrl);

        } catch (err) {
            console.error('Error fetching data:', err);
        }
    }


    async parseManifest_(data, baseURLFromMpdLink) {
        const mpd = xml_utils.parseXml(data, 'MPD');

        if (!mpd) {
            throw new Error("Invalid XML formated manifest");
        }

        return this.processManifest_(mpd, baseURLFromMpdLink);
    }


    /**
   * Takes a formatted MPD and converts it into a manifest.
   *
   * @param {!shaka.extern.xml.Node} mpd
   * @param {string} baseURLFromMpdLink
   * @return {!Promise}
   * @private
   */
    async processManifest_(mpd, baseURLFromMpdLink) {
        let manifestBaseUris = [];
        const locations = [];
        const locationsMapping = new Map();
        const locationsObjs = xml_utils.findChildren(mpd, 'Location');

        for (const locationsObj of locationsObjs) {
            const serviceLocation = locationsObj.attributes['serviceLocation'];
            const uri = xml_utils.getContents(locationsObj);
            if (!uri) {
                continue;
            }
            const finalUri = ManifestParserUtils.resolveUris(
                manifestBaseUris, [uri])[0];
            if (serviceLocation) {
                if (this.contentSteeringManager_) {
                    this.contentSteeringManager_.addLocation(
                        'Location', serviceLocation, finalUri);
                } else {
                    locationsMapping.set(serviceLocation, finalUri);
                }
            }
            locations.push(finalUri);
        }

        manifestBaseUris = locations;

        let contentSteeringPromise = Promise.resolve();
        const contentSteering = xml_utils.findChild(mpd, 'ContentSteering');

        if (contentSteering) {
            const defaultPathwayId =
                contentSteering.attributes['defaultServiceLocation'];
            if (!this.contentSteeringManager_) {
                this.contentSteeringManager_ = new ContentSteeringManager();
                this.contentSteeringManager_.configure(this.config_);
                this.contentSteeringManager_.setManifestType('DASH');
                this.contentSteeringManager_.setBaseUris(manifestBaseUris);
                this.contentSteeringManager_.setDefaultPathwayId(defaultPathwayId);
                const uri = xml_utils.getContents(contentSteering);
                if (uri) {
                    const queryBeforeStart =
                        xml_utils.parseAttr(contentSteering, 'queryBeforeStart',
                            xml_utils.parseBoolean, /* defaultValue= */ false);
                    if (queryBeforeStart) {
                        contentSteeringPromise =
                            this.contentSteeringManager_.requestInfo(uri);
                    } else {
                        this.contentSteeringManager_.requestInfo(uri);
                    }
                }
            } else {
                this.contentSteeringManager_.setBaseUris(manifestBaseUris);
                this.contentSteeringManager_.setDefaultPathwayId(defaultPathwayId);
            }
            for (const serviceLocation of locationsMapping.keys()) {
                const uri = locationsMapping.get(serviceLocation);
                this.contentSteeringManager_.addLocation(
                    'Location', serviceLocation, uri);
            }
        }

        const uriObjs = xml_utils.findChildren(mpd, 'BaseURL');
        let calculatedBaseUris;
        let someLocationValid = false;
        if (this.contentSteeringManager_) {
            for (const uriObj of uriObjs) {
                const serviceLocation = uriObj.attributes['serviceLocation'];
                const uri = xml_utils.getContents(uriObj);
                if (serviceLocation && uri) {
                    this.contentSteeringManager_.addLocation(
                        'BaseURL', serviceLocation, uri);
                    someLocationValid = true;
                }
            }
        }
        if (!someLocationValid || !this.contentSteeringManager_) {
            const uris = uriObjs.map(xml_utils.getContents);
            calculatedBaseUris = ManifestParserUtils.resolveUris(
                [baseURLFromMpdLink], uris);
        }

        const getBaseUris = () => {
            if (this.contentSteeringManager_) {
                return this.contentSteeringManager_.getLocations('BaseURL');
            }
            if (calculatedBaseUris) {
                return calculatedBaseUris;
            }
            return [];
        };

        let availabilityTimeOffset = 0;
        if (uriObjs && uriObjs.length) {
            availabilityTimeOffset = xml_utils.parseAttr(
                uriObjs[0], 'availabilityTimeOffset', xml_utils.parseFloat) || 0;
        }
        let minBufferTime =
            xml_utils.parseAttr(mpd, 'minBufferTime', xml_utils.parseDuration) || 0;

        this.updatePeriod_ = xml_utils.parseAttr(mpd, 'minimumUpdatePeriod',
            xml_utils.parseDuration, -1);

        const presentationStartTime = xml_utils.parseAttr(mpd, 'availabilityStartTime',
            xml_utils.parseDate);
        let segmentAvailabilityDuration = xml_utils.parseAttr(mpd, 'timeShiftBufferDepth',
            xml_utils.parseDuration);

        let suggestedPresentationDelay = xml_utils.parseAttr(
            mpd, 'suggestedPresentationDelay', xml_utils.parseDuration);

        let maxSegmentDuration = xml_utils.parseAttr(
            mpd, 'maxSegmentDuration', xml_utils.parseDuration);

        const mpdType = mpd.attributes['type'] || 'static';

        let presentationTimeline;
        if (!this.manifest_) {
            // DASH IOP v3.0 suggests using a default delay between minBufferTime
            // and timeShiftBufferDepth.  This is literally the range of all
            // feasible choices for the value.  Nothing older than
            // timeShiftBufferDepth is still available, and anything less than
            // minBufferTime will cause buffering issues.
            //
            // We have decided that our default will be the configured value, or
            // 1.5 * minBufferTime if not configured. This is fairly conservative.
            // Content providers should provide a suggestedPresentationDelay whenever
            // possible to optimize the live streaming experience.
            const defaultPresentationDelay =
                this.config_.defaultPresentationDelay || minBufferTime * 1.5;
            const presentationDelay = suggestedPresentationDelay != null ?
                suggestedPresentationDelay : defaultPresentationDelay;
            presentationTimeline = new PresentationTimeline(
                presentationStartTime, presentationDelay,
                this.config_.dash.autoCorrectDrift);
        }

        presentationTimeline.setStatic(mpdType == 'static');

        const isLive = presentationTimeline.isLive();

        // If it's live, we check for an override.
        if (isLive && !isNaN(this.config_.availabilityWindowOverride)) {
            segmentAvailabilityDuration = this.config_.availabilityWindowOverride;
        }

        // If it's null, that means segments are always available.  This is always
        // the case for VOD, and sometimes the case for live.
        if (segmentAvailabilityDuration == null) {
            segmentAvailabilityDuration = Infinity;
        }

        presentationTimeline.setSegmentAvailabilityDuration(
            segmentAvailabilityDuration);

        const profiles = mpd.attributes['profiles'] || '';

        /** @type {shaka.dash.DashParser.Context} */
        const context = {
            // Don't base on updatePeriod_ since emsg boxes can cause manifest
            // updates.
            dynamic: mpdType != 'static',
            presentationTimeline: presentationTimeline,
            period: null,
            periodInfo: null,
            adaptationSet: null,
            representation: null,
            bandwidth: 0,
            indexRangeWarningGiven: false,
            availabilityTimeOffset: availabilityTimeOffset,
            profiles: profiles.split(','),
        };

        const periodsAndDuration = this.parsePeriods_(context, getBaseUris, mpd);
        const duration = periodsAndDuration.duration;
        const periods = periodsAndDuration.periods;

        if (mpdType == 'static' ||
            !periodsAndDuration.durationDerivedFromPeriods) {
            // Ignore duration calculated from Period lengths if this is dynamic.
            presentationTimeline.setDuration(duration || Infinity);
        }

        // Use @maxSegmentDuration to override smaller, derived values.
        presentationTimeline.notifyMaxSegmentDuration(maxSegmentDuration || 1);

        await this.periodCombiner_.combinePeriods(periods, context.dynamic);
        await contentSteeringPromise;

        // These steps are not done on manifest update.
        if (!this.manifest_) {
            this.manifest_ = {
                presentationTimeline: presentationTimeline,
                variants: this.periodCombiner_.getVariants(),
                textStreams: this.periodCombiner_.getTextStreams(),
                imageStreams: this.periodCombiner_.getImageStreams(),
                offlineSessionIds: [],
                sequenceMode: this.config_.dash.sequenceMode,
                ignoreManifestTimestampsInSegmentsMode: false,
                type: "DASH",
                serviceDescription: this.parseServiceDescription_(mpd),
            };

            // We only need to do clock sync when we're using presentation start
            // time. This condition also excludes VOD streams.
            if (presentationTimeline.usingPresentationStartTime()) {
                const timingElements = xml_utils.findChildren(mpd, 'UTCTiming');
                const offset = await this.parseUtcTiming_(getBaseUris, timingElements);
                // Detect calls to stop().
                if (!this.playerInterface_) {
                    return;
                }
                presentationTimeline.setClockOffset(offset);
            }

            // This is the first point where we have a meaningful presentation start
            // time, and we need to tell PresentationTimeline that so that it can
            // maintain consistency from here on.
            presentationTimeline.lockStartTime();
        }
    }

    /**
   * Reads and parses the periods from the manifest.  This first does some
   * partial parsing so the start and duration is available when parsing
   * children.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {function():!Array.<string>} getBaseUris
   * @param {!shaka.extern.xml.Node} mpd
   * @return {{
   *   periods: !Array.<shaka.extern.Period>,
    *   duration: ?number,
    *   durationDerivedFromPeriods: boolean
    * }}
    * @private
    */
    parsePeriods_(context, getBaseUris, mpd) {
        const presentationDuration = xml_utils.parseAttr(
            mpd, 'mediaPresentationDuration', xml_utils.parseDuration);

        const periods = [];
        let prevEnd = 0;
        const periodNodes = xml_utils.findChildren(mpd, 'Period');

        for (let i = 0; i < periodNodes.length; i++) {
            const elem = periodNodes[i];
            const next = periodNodes[i + 1];
            const start = /** @type {number} */ (
                xml_utils.parseAttr(elem, 'start', xml_utils.parseDuration, prevEnd));
            const periodId = elem.attributes['id'];
            const givenDuration =
                xml_utils.parseAttr(elem, 'duration', xml_utils.parseDuration);

            logger.info(`Period ${periodId}: start: ${start} duration: ${givenDuration}`);

            let periodDuration = null;
            if (next) {
                // "The difference between the start time of a Period and the start time
                // of the following Period is the duration of the media content
                // represented by this Period."
                const nextStart =
                    xml_utils.parseAttr(next, 'start', xml_utils.parseDuration);
                if (nextStart != null) {
                    periodDuration = nextStart - start;
                }
            } else if (presentationDuration != null) {
                // "The Period extends until the Period.start of the next Period, or
                // until the end of the Media Presentation in the case of the last
                // Period."
                periodDuration = presentationDuration - start;
            }

            const threshold = ManifestParserUtils.GAP_OVERLAP_TOLERANCE_SECONDS;
            if (periodDuration && givenDuration &&
                Math.abs(periodDuration - givenDuration) > threshold) {
                logger.warning('There is a gap/overlap between Periods', elem);
            }
            // Only use the @duration in the MPD if we can't calculate it.  We should
            // favor the @start of the following Period.  This ensures that there
            // aren't gaps between Periods.
            if (periodDuration == null) {
                periodDuration = givenDuration;
            }

            /**
             * This is to improve robustness when the player observes manifest with
             * past periods that are inconsistent to previous ones.
             *
             * This may happen when a CDN or proxy server switches its upstream from
             * one encoder to another redundant encoder.
             *
             * Skip periods that match all of the following criteria:
             * - Start time is earlier than latest period start time ever seen
             * - Period ID is never seen in the previous manifest
             * - Not the last period in the manifest
             *
             * Periods that meet the aforementioned criteria are considered invalid
             * and should be safe to discard.
             */

            if (this.largestPeriodStartTime_ !== null &&
                periodId !== null && start !== null &&
                start < this.largestPeriodStartTime_ &&
                !this.lastManifestUpdatePeriodIds_.includes(periodId) &&
                i + 1 != periodNodes.length) {
                logger.debug(
                    `Skipping Period with ID ${periodId} as its start time is smaller` +
                    ' than the largest period start time that has been seen, and ID ' +
                    'is unseen before');
                continue;
            }


            // Save maximum period start time if it is the last period
            if (start !== null &&
                (this.largestPeriodStartTime_ === null ||
                    start > this.largestPeriodStartTime_)) {
                this.largestPeriodStartTime_ = start;
            }

            // Parse child nodes.
            const info = {
                start: start,
                duration: periodDuration,
                node: elem,
                isLastPeriod: periodDuration == null || !next,
            };
            const period = this.parsePeriod_(context, getBaseUris, info);
            periods.push(period);

            if (context.period.id && periodDuration) {
                this.periodDurations_[context.period.id] = periodDuration;
            }

            if (periodDuration == null) {
                if (next) {
                    // If the duration is still null and we aren't at the end, then we
                    // will skip any remaining periods.
                    logger.warning(
                        'Skipping Period', i + 1, 'and any subsequent Periods:', 'Period',
                        i + 1, 'does not have a valid start time.', next);
                }

                // The duration is unknown, so the end is unknown.
                prevEnd = null;
                break;
            }

            prevEnd = start + periodDuration;
        } // end of period parsing loop

        // Replace previous seen periods with the current one.
        this.lastManifestUpdatePeriodIds_ = periods.map((el) => el.id);

        if (presentationDuration != null) {
            if (prevEnd != presentationDuration) {
                logger.warning(
                    '@mediaPresentationDuration does not match the total duration of ',
                    'all Periods.');
                // Assume @mediaPresentationDuration is correct.
            }
            return {
                periods: periods,
                duration: presentationDuration,
                durationDerivedFromPeriods: false,
            };
        } else {
            return {
                periods: periods,
                duration: prevEnd,
                durationDerivedFromPeriods: true,
            };
        }
    }

    /**
    * Parses a Period XML element.  Unlike the other parse methods, this is not
    * given the Node; it is given a PeriodInfo structure.  Also, partial parsing
    * was done before this was called so start and duration are valid.
    *
    * @param {shaka.dash.DashParser.Context} context
    * @param {function():!Array.<string>} getBaseUris
    * @param {shaka.dash.DashParser.PeriodInfo} periodInfo
    * @return {shaka.extern.Period}
    * @private
    */
    parsePeriod_(context, getBaseUris, periodInfo) {
        const ContentType = ManifestParserUtils.ContentType;

        context.period = this.createFrame_(periodInfo.node, null, getBaseUris);
        context.periodInfo = periodInfo;
        context.period.availabilityTimeOffset = context.availabilityTimeOffset;

        // If the period doesn't have an ID, give it one based on its start time.
        if (!context.period.id) {
            logger.info(
                'No Period ID given for Period with start time ' + periodInfo.start +
                ',  Assigning a default');
            context.period.id = '_period_' + periodInfo.start;
        }

        const eventStreamNodes =
            xml_utils.findChildren(periodInfo.node, 'EventStream');
        // const availabilityStart =
        //     context.presentationTimeline.getSegmentAvailabilityStart();

        // for (const node of eventStreamNodes) {
        //   this.parseEventStream_(
        //       periodInfo.start, periodInfo.duration, node, availabilityStart);
        // }

        const adaptationSetNodes =
            xml_utils.findChildren(periodInfo.node, 'AdaptationSet');
        const adaptationSets = adaptationSetNodes
            .map((node) => this.parseAdaptationSet_(context, node))
            .filter(Functional.isNotNull);

        // For dynamic manifests, we use rep IDs internally, and they must be
        // unique.
        if (context.dynamic) {
            const ids = [];
            for (const set of adaptationSets) {
                for (const id of set.representationIds) {
                    ids.push(id);
                }
            }

            const uniqueIds = new Set(ids);

            if (ids.length != uniqueIds.size) {
                throw new Error("DASH_DUPLICATE_REPRESENTATION_ID");
            }
        }

        const normalAdaptationSets = adaptationSets
            .filter((as) => { return !as.trickModeFor; });

        const trickModeAdaptationSets = adaptationSets
            .filter((as) => { return as.trickModeFor; });

        // Attach trick mode tracks to normal tracks.
        for (const trickModeSet of trickModeAdaptationSets) {
            const targetIds = trickModeSet.trickModeFor.split(' ');
            for (const normalSet of normalAdaptationSets) {
                if (targetIds.includes(normalSet.id)) {
                    for (const stream of normalSet.streams) {
                        // There may be multiple trick mode streams, but we do not
                        // currently support that.  Just choose one.
                        // TODO: https://github.com/shaka-project/shaka-player/issues/1528
                        stream.trickModeVideo = trickModeSet.streams.find((trickStream) =>
                            MimeUtils.getNormalizedCodec(stream.codecs) ==
                            MimeUtils.getNormalizedCodec(trickStream.codecs));
                    }
                }
            }
        }

        const audioStreams = this.getStreamsFromSets_(
            this.config_.disableAudio,
            normalAdaptationSets,
            ContentType.AUDIO);
        const videoStreams = this.getStreamsFromSets_(
            this.config_.disableVideo,
            normalAdaptationSets,
            ContentType.VIDEO);
        const textStreams = this.getStreamsFromSets_(
            this.config_.disableText,
            normalAdaptationSets,
            ContentType.TEXT);
        const imageStreams = this.getStreamsFromSets_(
            this.config_.disableThumbnails,
            normalAdaptationSets,
            ContentType.IMAGE);

        if (videoStreams.length === 0 && audioStreams.length === 0) {
            throw new Error(
                Error.Severity.CRITICAL,
                Error.Category.MANIFEST,
                Error.Code.DASH_EMPTY_PERIOD,
            );
        }

        return {
            id: context.period.id,
            audioStreams,
            videoStreams,
            textStreams,
            imageStreams,
        };
    }

    /**
     * Creates a new inheritance frame for the given element.
     *
     * @param {!shaka.extern.xml.Node} elem
     * @param {?shaka.dash.DashParser.InheritanceFrame} parent
     * @param {?function():!Array.<string>} getBaseUris
     * @return {shaka.dash.DashParser.InheritanceFrame}
     * @private
     */
    createFrame_(elem, parent, getBaseUris) {
        assert(parent || getBaseUris,
            'Must provide either parent or getBaseUris');

        parent = parent || /** @type {shaka.dash.DashParser.InheritanceFrame} */ ({
            contentType: '',
            mimeType: '',
            codecs: '',
            emsgSchemeIdUris: [],
            frameRate: undefined,
            pixelAspectRatio: undefined,
            numChannels: null,
            audioSamplingRate: null,
            availabilityTimeOffset: 0,
            segmentSequenceCadence: 0,
        });
        getBaseUris = getBaseUris || parent.getBaseUris;

        const parseNumber = xml_utils.parseNonNegativeInt;
        const evalDivision = xml_utils.evalDivision;

        const id = elem.attributes['id'];
        const uriObjs = xml_utils.findChildren(elem, 'BaseURL');

        let calculatedBaseUris;
        let someLocationValid = false;
        if (this.contentSteeringManager_) {
            for (const uriObj of uriObjs) {
                const serviceLocation = uriObj.attributes['serviceLocation'];
                const uri = xml_utils.getContents(uriObj);

                if (serviceLocation && uri) {
                    this.contentSteeringManager_.addLocation(
                        id, serviceLocation, uri);
                    someLocationValid = true;
                }
            }
        }
        if (!someLocationValid || !this.contentSteeringManager_) {
            calculatedBaseUris = uriObjs.map(xml_utils.getContents);
        }

        const getFrameUris = () => {
            if (!uriObjs.length) {
                return [];
            }
            if (this.contentSteeringManager_ && someLocationValid) {
                return this.contentSteeringManager_.getLocations(id);
            }
            if (calculatedBaseUris) {
                return calculatedBaseUris;
            }
            return [];
        };

        let contentType = elem.attributes['contentType'] || parent.contentType;
        const mimeType = elem.attributes['mimeType'] || parent.mimeType;
        const codecs = elem.attributes['codecs'] || parent.codecs;
        const frameRate =
            xml_utils.parseAttr(elem, 'frameRate', evalDivision) || parent.frameRate;
        const pixelAspectRatio =
            elem.attributes['sar'] || parent.pixelAspectRatio;
        const emsgSchemeIdUris = this.emsgSchemeIdUris_(
            xml_utils.findChildren(elem, 'InbandEventStream'),
            parent.emsgSchemeIdUris);
        const audioChannelConfigs =
            xml_utils.findChildren(elem, 'AudioChannelConfiguration');
        const numChannels =
            this.parseAudioChannels_(audioChannelConfigs) || parent.numChannels;
        const audioSamplingRate =
            xml_utils.parseAttr(elem, 'audioSamplingRate', parseNumber) ||
            parent.audioSamplingRate;

        if (!contentType) {
            contentType = DashMpdParser.guessContentType_(mimeType, codecs);
        }

        const segmentBase = xml_utils.findChild(elem, 'SegmentBase');
        const segmentTemplate = xml_utils.findChild(elem, 'SegmentTemplate');

        // The availabilityTimeOffset is the sum of all @availabilityTimeOffset
        // values that apply to the adaptation set, via BaseURL, SegmentBase,
        // or SegmentTemplate elements.
        const segmentBaseAto = segmentBase ?
            (xml_utils.parseAttr(segmentBase, 'availabilityTimeOffset',
                xml_utils.parseFloat) || 0) : 0;
        const segmentTemplateAto = segmentTemplate ?
            (xml_utils.parseAttr(segmentTemplate, 'availabilityTimeOffset',
                xml_utils.parseFloat) || 0) : 0;
        const baseUriAto = uriObjs && uriObjs.length ?
            (xml_utils.parseAttr(uriObjs[0], 'availabilityTimeOffset',
                xml_utils.parseFloat) || 0) : 0;

        const availabilityTimeOffset = parent.availabilityTimeOffset + baseUriAto +
            segmentBaseAto + segmentTemplateAto;

        let segmentSequenceCadence = null;
        const segmentSequenceProperties =
            xml_utils.findChild(elem, 'SegmentSequenceProperties');
        if (segmentSequenceProperties) {
            const sap = xml_utils.findChild(segmentSequenceProperties, 'SAP');
            if (sap) {
                segmentSequenceCadence = xml_utils.parseAttr(sap, 'cadence',
                    xml_utils.parseInt);
            }
        }

        return {
            getBaseUris:
                () => ManifestParserUtils.resolveUris(getBaseUris(), getFrameUris()),
            segmentBase: segmentBase || parent.segmentBase,
            segmentList:
                xml_utils.findChild(elem, 'SegmentList') || parent.segmentList,
            segmentTemplate: segmentTemplate || parent.segmentTemplate,
            width: xml_utils.parseAttr(elem, 'width', parseNumber) || parent.width,
            height: xml_utils.parseAttr(elem, 'height', parseNumber) || parent.height,
            contentType: contentType,
            mimeType: mimeType,
            codecs: codecs,
            frameRate: frameRate,
            pixelAspectRatio: pixelAspectRatio,
            emsgSchemeIdUris: emsgSchemeIdUris,
            id: id,
            language: elem.attributes['lang'],
            numChannels: numChannels,
            audioSamplingRate: audioSamplingRate,
            availabilityTimeOffset: availabilityTimeOffset,
            segmentSequenceCadence:
                segmentSequenceCadence || parent.segmentSequenceCadence,
        };
    }

    /**
   * Returns a new array of InbandEventStream schemeIdUri containing the union
   * of the ones parsed from inBandEventStreams and the ones provided in
   * emsgSchemeIdUris.
   *
   * @param {!Array.<!shaka.extern.xml.Node>} inBandEventStreams
   *     Array of InbandEventStreampa
   *     elements to parse and add to the returned array.
   * @param {!Array.<string>} emsgSchemeIdUris Array of parsed
   *     InbandEventStream schemeIdUri attributes to add to the returned array.
   * @return {!Array.<string>} schemeIdUris Array of parsed
   *     InbandEventStream schemeIdUri attributes.
   * @private
   */
    emsgSchemeIdUris_(inBandEventStreams, emsgSchemeIdUris) {
        const schemeIdUris = emsgSchemeIdUris.slice();
        for (const event of inBandEventStreams) {
            const schemeIdUri = event.attributes['schemeIdUri'];
            if (!schemeIdUris.includes(schemeIdUri)) {
                schemeIdUris.push(schemeIdUri);
            }
        }
        return schemeIdUris;
    }

    /**
     * @param {!Array.<!shaka.extern.xml.Node>} audioChannelConfigs An array of
     *   AudioChannelConfiguration elements.
     * @return {?number} The number of audio channels, or null if unknown.
     * @private
     */
    parseAudioChannels_(audioChannelConfigs) {
        for (const elem of audioChannelConfigs) {
            const scheme = elem.attributes['schemeIdUri'];
            if (!scheme) {
                continue;
            }

            const value = elem.attributes['value'];
            if (!value) {
                continue;
            }

            switch (scheme) {
                case 'urn:mpeg:dash:outputChannelPositionList:2012':
                    // A space-separated list of speaker positions, so the number of
                    // channels is the length of this list.
                    return value.trim().split(/ +/).length;

                case 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011':
                case 'urn:dts:dash:audio_channel_configuration:2012': {
                    // As far as we can tell, this is a number of channels.
                    const intValue = parseInt(value, 10);
                    if (!intValue) {  // 0 or NaN
                        logger.warning('Channel parsing failure! ' +
                            'Ignoring scheme and value', scheme, value);
                        continue;
                    }
                    return intValue;
                }

                case 'tag:dolby.com,2014:dash:audio_channel_configuration:2011':
                case 'urn:dolby:dash:audio_channel_configuration:2011': {
                    // A hex-encoded 16-bit integer, in which each bit represents a
                    // channel.
                    let hexValue = parseInt(value, 16);
                    if (!hexValue) {  // 0 or NaN
                        logger.warning('Channel parsing failure! ' +
                            'Ignoring scheme and value', scheme, value);
                        continue;
                    }
                    // Count the 1-bits in hexValue.
                    let numBits = 0;
                    while (hexValue) {
                        if (hexValue & 1) {
                            ++numBits;
                        }
                        hexValue >>= 1;
                    }
                    return numBits;
                }

                // Defined by https://dashif.org/identifiers/audio_source_metadata/ and clause 8.2, in ISO/IEC 23001-8.
                case 'urn:mpeg:mpegB:cicp:ChannelConfiguration': {
                    const noValue = 0;
                    const channelCountMapping = [
                        noValue, 1, 2, 3, 4, 5, 6, 8, 2, 3, /* 0--9 */
                        4, 7, 8, 24, 8, 12, 10, 12, 14, 12, /* 10--19 */
                        14, /* 20 */
                    ];
                    const intValue = parseInt(value, 10);
                    if (!intValue) {  // 0 or NaN
                        logger.warning('Channel parsing failure! ' +
                            'Ignoring scheme and value', scheme, value);
                        continue;
                    }
                    if (intValue > noValue && intValue < channelCountMapping.length) {
                        return channelCountMapping[intValue];
                    }
                    continue;
                }

                default:
                    logger.warning(
                        'Unrecognized audio channel scheme:', scheme, value);
                    continue;
            }
        }

        return null;
    }

    /**
     * Parses an AdaptationSet XML element.
     *
     * @param {shaka.dash.DashParser.Context} context
     * @param {!shaka.extern.xml.Node} elem The AdaptationSet element.
     * @return {?shaka.dash.DashParser.AdaptationInfo}
     * @private
     */
    parseAdaptationSet_(context, elem) {
        const ContentType = ManifestParserUtils.ContentType;
        // const ContentProtection = shaka.dash.ContentProtection;

        context.adaptationSet = this.createFrame_(elem, context.period, null);

        let main = false;
        const roleElements = xml_utils.findChildren(elem, 'Role');
        const roleValues = roleElements.map((role) => {
            return role.attributes['value'];
        }).filter(Functional.isNotNull);

        // Default kind for text streams is 'subtitle' if unspecified in the
        // manifest.
        let kind = undefined;
        const isText = context.adaptationSet.contentType == ContentType.TEXT;
        if (isText) {
            kind = ManifestParserUtils.TextStreamKind.SUBTITLE;
        }

        for (const roleElement of roleElements) {
            const scheme = roleElement.attributes['schemeIdUri'];
            if (scheme == null || scheme == 'urn:mpeg:dash:role:2011') {
                // These only apply for the given scheme, but allow them to be specified
                // if there is no scheme specified.
                // See: DASH section 5.8.5.5
                const value = roleElement.attributes['value'];
                switch (value) {
                    case 'main':
                        main = true;
                        break;
                    case 'caption':
                    case 'subtitle':
                        kind = value;
                        break;
                }
            }
        }

        // Parallel for HLS VIDEO-RANGE as defined in DASH-IF IOP v4.3 6.2.5.1.
        let videoRange;

        // Ref. https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf
        // If signaled, a Supplemental or Essential Property descriptor
        // shall be used, with the schemeIdUri set to
        // urn:mpeg:mpegB:cicp:<Parameter> as defined in
        // ISO/IEC 23001-8 [49] and <Parameter> one of the
        // following: ColourPrimaries, TransferCharacteristics,
        // or MatrixCoefficients.
        const scheme = 'urn:mpeg:mpegB:cicp';
        const transferCharacteristicsScheme = `${scheme}:TransferCharacteristics`;
        const colourPrimariesScheme = `${scheme}:ColourPrimaries`;
        const matrixCoefficientsScheme = `${scheme}:MatrixCoefficients`;

        const getVideoRangeFromTransferCharacteristicCICP = (cicp) => {
            switch (cicp) {
                case 1:
                case 6:
                case 13:
                case 14:
                case 15:
                    return 'SDR';
                case 16:
                    return 'PQ';
                case 18:
                    return 'HLG';
            }
            return undefined;
        };

        const essentialProperties =
            xml_utils.findChildren(elem, 'EssentialProperty');
        // ID of real AdaptationSet if this is a trick mode set:
        let trickModeFor = null;
        let isFastSwitching = false;
        let unrecognizedEssentialProperty = false;
        for (const prop of essentialProperties) {
            const schemeId = prop.attributes['schemeIdUri'];
            if (schemeId == 'http://dashif.org/guidelines/trickmode') {
                trickModeFor = prop.attributes['value'];
            } else if (schemeId == transferCharacteristicsScheme) {
                videoRange = getVideoRangeFromTransferCharacteristicCICP(
                    parseInt(prop.attributes['value'], 10),
                );
            } else if (schemeId == colourPrimariesScheme ||
                schemeId == matrixCoefficientsScheme) {
                continue;
            } else if (schemeId == 'urn:mpeg:dash:ssr:2023') {
                isFastSwitching = true;
            } else {
                unrecognizedEssentialProperty = true;
            }
        }

        const supplementalProperties =
            xml_utils.findChildren(elem, 'SupplementalProperty');
        for (const prop of supplementalProperties) {
            const schemeId = prop.attributes['schemeIdUri'];
            if (schemeId == transferCharacteristicsScheme) {
                videoRange = getVideoRangeFromTransferCharacteristicCICP(
                    parseInt(prop.attributes['value'], 10),
                );
            }
        }

        const accessibilities = xml_utils.findChildren(elem, 'Accessibility');
        const closedCaptions = new Map();
        /** @type {?shaka.media.ManifestParser.AccessibilityPurpose} */
        let accessibilityPurpose;
        for (const prop of accessibilities) {
            const schemeId = prop.attributes['schemeIdUri'];
            const value = prop.attributes['value'];
            if (schemeId == 'urn:scte:dash:cc:cea-608:2015') {
                let channelId = 1;
                if (value != null) {
                    const channelAssignments = value.split(';');
                    for (const captionStr of channelAssignments) {
                        let channel;
                        let language;
                        // Some closed caption descriptions have channel number and
                        // language ("CC1=eng") others may only have language ("eng,spa").
                        if (!captionStr.includes('=')) {
                            // When the channel assignemnts are not explicitly provided and
                            // there are only 2 values provided, it is highly likely that the
                            // assignments are CC1 and CC3 (most commonly used CC streams).
                            // Otherwise, cycle through all channels arbitrarily (CC1 - CC4)
                            // in order of provided langs.
                            channel = `CC${channelId}`;
                            if (channelAssignments.length == 2) {
                                channelId += 2;
                            } else {
                                channelId++;
                            }
                            language = captionStr;
                        } else {
                            const channelAndLanguage = captionStr.split('=');
                            // The channel info can be '1' or 'CC1'.
                            // If the channel info only has channel number(like '1'), add 'CC'
                            // as prefix so that it can be a full channel id (like 'CC1').
                            channel = channelAndLanguage[0].startsWith('CC') ?
                                channelAndLanguage[0] : `CC${channelAndLanguage[0]}`;

                            // 3 letters (ISO 639-2).  In b/187442669, we saw a blank string
                            // (CC2=;CC3=), so default to "und" (the code for "undetermined").
                            language = channelAndLanguage[1] || 'und';
                        }
                        closedCaptions.set(channel, LanguageUtils.normalize(language));
                    }
                } else {
                    // If channel and language information has not been provided, assign
                    // 'CC1' as channel id and 'und' as language info.
                    closedCaptions.set('CC1', 'und');
                }
            } else if (schemeId == 'urn:scte:dash:cc:cea-708:2015') {
                let serviceNumber = 1;
                if (value != null) {
                    for (const captionStr of value.split(';')) {
                        let service;
                        let language;
                        // Similar to CEA-608, it is possible that service # assignments
                        // are not explicitly provided e.g. "eng;deu;swe" In this case,
                        // we just cycle through the services for each language one by one.
                        if (!captionStr.includes('=')) {
                            service = `svc${serviceNumber}`;
                            serviceNumber++;
                            language = captionStr;
                        } else {
                            // Otherwise, CEA-708 caption values take the form "
                            // 1=lang:eng;2=lang:deu" i.e. serviceNumber=lang:threelettercode.
                            const serviceAndLanguage = captionStr.split('=');
                            service = `svc${serviceAndLanguage[0]}`;

                            // The language info can be different formats, lang:eng',
                            // or 'lang:eng,war:1,er:1'. Extract the language info.
                            language = serviceAndLanguage[1].split(',')[0].split(':').pop();
                        }
                        closedCaptions.set(service, LanguageUtils.normalize(language));
                    }
                } else {
                    // If service and language information has not been provided, assign
                    // 'svc1' as service number and 'und' as language info.
                    closedCaptions.set('svc1', 'und');
                }
            } else if (schemeId == 'urn:mpeg:dash:role:2011') {
                // See DASH IOP 3.9.2 Table 4.
                if (value != null) {
                    roleValues.push(value);
                    if (value == 'captions') {
                        kind = ManifestParserUtils.TextStreamKind.CLOSED_CAPTION;
                    }
                }
            } else if (schemeId == 'urn:tva:metadata:cs:AudioPurposeCS:2007') {
                // See DASH DVB Document A168 Rev.6 Table 5.
                if (value == '1') {
                    accessibilityPurpose =
                        shaka.media.ManifestParser.AccessibilityPurpose.VISUALLY_IMPAIRED;
                } else if (value == '2') {
                    accessibilityPurpose =
                        shaka.media.ManifestParser.AccessibilityPurpose.HARD_OF_HEARING;
                }
            }
        }

        // According to DASH spec (2014) section 5.8.4.8, "the successful processing
        // of the descriptor is essential to properly use the information in the
        // parent element".  According to DASH IOP v3.3, section 3.3.4, "if the
        // scheme or the value" for EssentialProperty is not recognized, "the DASH
        // client shall ignore the parent element."
        if (unrecognizedEssentialProperty) {
            // Stop parsing this AdaptationSet and let the caller filter out the
            // nulls.
            return null;
        }

        // const contentProtectionElems =
        //     xml_utils.findChildren(elem, 'ContentProtection');
        // const contentProtection = ContentProtection.parseFromAdaptationSet(
        //     contentProtectionElems,
        //     this.config_.dash.ignoreDrmInfo,
        //     this.config_.dash.keySystemsByURI);

        const language = LanguageUtils.normalize(
            context.adaptationSet.language || 'und');

        // This attribute is currently non-standard, but it is supported by Kaltura.
        let label = elem.attributes['label'];

        // Parse Representations into Streams.
        const representations = xml_utils.findChildren(elem, 'Representation');
        const streams = representations.map((representation) => {
            const parsedRepresentation = this.parseRepresentation_(context,
                null, kind, language, label, main, roleValues,
                closedCaptions, representation, accessibilityPurpose);
            if (parsedRepresentation) {
                parsedRepresentation.hdr = parsedRepresentation.hdr || videoRange;
                parsedRepresentation.fastSwitching = isFastSwitching;
            }
            return parsedRepresentation;
        }).filter((s) => !!s);

        if (streams.length == 0) {
            const isImage = context.adaptationSet.contentType == ContentType.IMAGE;
            // Ignore empty AdaptationSets if ignoreEmptyAdaptationSet is true
            // or they are for text/image content.
            if (this.config_.dash.ignoreEmptyAdaptationSet || isText || isImage) {
                return null;
            }
            throw new Error("Empty Adaptation Set");
        }

        // If AdaptationSet's type is unknown or is ambiguously "application",
        // guess based on the information in the first stream.  If the attributes
        // mimeType and codecs are split across levels, they will both be inherited
        // down to the stream level by this point, so the stream will have all the
        // necessary information.
        if (!context.adaptationSet.contentType ||
            context.adaptationSet.contentType == ContentType.APPLICATION) {
            const mimeType = streams[0].mimeType;
            const codecs = streams[0].codecs;
            context.adaptationSet.contentType = DashMpdParser.guessContentType_(mimeType, codecs);

            for (const stream of streams) {
                stream.type = context.adaptationSet.contentType;
            }
        }

        const adaptationId = context.adaptationSet.id ||
            ('__fake__' + this.globalId_++);

        for (const stream of streams) {
            // // Some DRM license providers require that we have a default
            // // key ID from the manifest in the wrapped license request.
            // // Thus, it should be put in drmInfo to be accessible to request filters.
            // for (const drmInfo of contentProtection.drmInfos) {
            //     drmInfo.keyIds = drmInfo.keyIds && stream.keyIds ?
            //         new Set([...drmInfo.keyIds, ...stream.keyIds]) :
            //         drmInfo.keyIds || stream.keyIds;
            // }
            if (this.config_.dash.enableAudioGroups) {
                stream.groupId = adaptationId;
            }
        }

        const repIds = representations
            .map((node) => { return node.attributes['id']; })
            .filter(Functional.isNotNull);

        return {
            id: adaptationId,
            contentType: context.adaptationSet.contentType,
            language: language,
            main: main,
            streams: streams,
            // drmInfos: contentProtection.drmInfos,
            trickModeFor: trickModeFor,
            representationIds: repIds,
        };
    }

    /**
     * Parses a Representation XML element.
     *
     * @param {shaka.dash.DashParser.Context} context
     * @param {shaka.dash.ContentProtection.Context} contentProtection
     * @param {(string|undefined)} kind
     * @param {string} language
     * @param {string} label
     * @param {boolean} isPrimary
     * @param {!Array.<string>} roles
     * @param {Map.<string, string>} closedCaptions
     * @param {!shaka.extern.xml.Node} node
     * @param {?shaka.media.ManifestParser.AccessibilityPurpose}
     *   accessibilityPurpose
     *
     * @return {?shaka.extern.Stream} The Stream, or null when there is a
     *   non-critical parsing error.
     * @private
     */
    parseRepresentation_(context, contentProtection, kind, language, label,
        isPrimary, roles, closedCaptions, node, accessibilityPurpose) {
        const ContentType = ManifestParserUtils.ContentType;

        context.representation =
            this.createFrame_(node, context.adaptationSet, null);

        this.minTotalAvailabilityTimeOffset_ =
            Math.min(this.minTotalAvailabilityTimeOffset_,
                context.representation.availabilityTimeOffset);

        if (!this.verifyRepresentation_(context.representation)) {
            logger.warning('Skipping Representation', context.representation);
            return null;
        }
        const periodStart = context.periodInfo.start;

        // NOTE: bandwidth is a mandatory attribute according to the spec, and zero
        // does not make sense in the DASH spec's bandwidth formulas.
        // In some content, however, the attribute is missing or zero.
        // To avoid NaN at the variant level on broken content, fall back to zero.
        // https://github.com/shaka-project/shaka-player/issues/938#issuecomment-317278180
        context.bandwidth =
            xml_utils.parseAttr(node, 'bandwidth', xml_utils.parsePositiveInt) || 0;

        /** @type {?shaka.dash.DashParser.StreamInfo} */
        let streamInfo;

        const contentType = context.representation.contentType;
        const isText = contentType == ContentType.TEXT ||
            contentType == ContentType.APPLICATION;
        const isImage = contentType == ContentType.IMAGE;

        try {
            /** @type {shaka.extern.aesKey|undefined} */
            let aesKey = undefined;
            // if (contentProtection.aes128Info) {
            //     const getBaseUris = context.representation.getBaseUris;
            //     const uris = ManifestParserUtils.resolveUris(
            //         getBaseUris(), [contentProtection.aes128Info.keyUri]);
            //     const requestType = shaka.net.NetworkingEngine.RequestType.KEY;
            //     const request = shaka.net.NetworkingEngine.makeRequest(
            //         uris, this.config_.retryParameters);

            //     aesKey = {
            //         bitsKey: 128,
            //         blockCipherMode: 'CBC',
            //         iv: contentProtection.aes128Info.iv,
            //         firstMediaSequenceNumber: 0,
            //     };

            //     // Don't download the key object until the segment is parsed, to
            //     // avoid a startup delay for long manifests with lots of keys.
            //     aesKey.fetchKey = async () => {
            //         const keyResponse =
            //             await this.makeNetworkRequest_(request, requestType);

            //         // keyResponse.status is undefined when URI is
            //         // "data:text/plain;base64,"
            //         if (!keyResponse.data || keyResponse.data.byteLength != 16) {
            //             throw new Error(
            //                 Error.Severity.CRITICAL,
            //                 Error.Category.MANIFEST,
            //                 Error.Code.AES_128_INVALID_KEY_LENGTH);
            //         }

            //         const algorithm = {
            //             name: 'AES-CBC',
            //         };
            //         aesKey.cryptoKey = await window.crypto.subtle.importKey(
            //             'raw', keyResponse.data, algorithm, true, ['decrypt']);
            //         aesKey.fetchKey = undefined; // No longer needed.
            //     };
            // }
            const requestSegment = (uris, startByte, endByte, isInit) => {
                // return this.requestSegment_(uris, startByte, endByte, isInit);
                return null;
            };

            if (context.representation.segmentBase) {
                streamInfo = SegmentBase.createStreamInfo(
                    context, requestSegment, aesKey);
            } else if (context.representation.segmentList) {
                streamInfo = SegmentList.createStreamInfo(
                    context, this.streamMap_, aesKey);
            } else if (context.representation.segmentTemplate) {
                const hasManifest = !!this.manifest_;

                streamInfo = SegmentTemplate.createStreamInfo(
                    context, requestSegment, this.streamMap_, hasManifest,
                    this.config_.dash.initialSegmentLimit, this.periodDurations_,
                    aesKey);
            } else {
                assert(isText,
                    'Must have Segment* with non-text streams.');

                const duration = context.periodInfo.duration || 0;
                const getBaseUris = context.representation.getBaseUris;
                streamInfo = {
                    generateSegmentIndex: () => {
                        return Promise.resolve(SegmentIndex.forSingleSegment(
                            periodStart, duration, getBaseUris()));
                    },
                };
            }
        } catch (error) {
            if ((isText || isImage) &&
                error.code == Error.Code.DASH_NO_SEGMENT_INFO) {
                // We will ignore any DASH_NO_SEGMENT_INFO errors for text/image
                // streams.
                return null;
            }

            // For anything else, re-throw.
            throw error;
        }

        // const contentProtectionElems =
        //     xml_utils.findChildren(node, 'ContentProtection');
        // const keyId = shaka.dash.ContentProtection.parseFromRepresentation(
        //     contentProtectionElems, contentProtection,
        //     this.config_.dash.ignoreDrmInfo,
        //     this.config_.dash.keySystemsByURI);
        // const keyIds = new Set(keyId ? [keyId] : []);

        // Detect the presence of E-AC3 JOC audio content, using DD+JOC signaling.
        // See: ETSI TS 103 420 V1.2.1 (2018-10)
        const supplementalPropertyElems =
            xml_utils.findChildren(node, 'SupplementalProperty');
        const hasJoc = supplementalPropertyElems.some((element) => {
            const expectedUri = 'tag:dolby.com,2018:dash:EC3_ExtensionType:2018';
            const expectedValue = 'JOC';
            return element.attributes['schemeIdUri'] == expectedUri &&
                element.attributes['value'] == expectedValue;
        });
        let spatialAudio = false;
        if (hasJoc) {
            spatialAudio = true;
        }

        let forced = false;
        if (isText) {
            // See: https://github.com/shaka-project/shaka-player/issues/2122 and
            // https://github.com/Dash-Industry-Forum/DASH-IF-IOP/issues/165
            forced = roles.includes('forced_subtitle') ||
                roles.includes('forced-subtitle');
        }

        let tilesLayout;
        if (isImage) {
            const essentialPropertyElems =
                xml_utils.findChildren(node, 'EssentialProperty');
            const thumbnailTileElem = essentialPropertyElems.find((element) => {
                const expectedUris = [
                    'http://dashif.org/thumbnail_tile',
                    'http://dashif.org/guidelines/thumbnail_tile',
                ];
                return expectedUris.includes(element.attributes['schemeIdUri']);
            });
            if (thumbnailTileElem) {
                tilesLayout = thumbnailTileElem.attributes['value'];
            }
            // Filter image adaptation sets that has no tilesLayout.
            if (!tilesLayout) {
                return null;
            }
        }

        let hdr;
        const profiles = context.profiles;
        const codecs = context.representation.codecs;

        const hevcHDR = 'http://dashif.org/guidelines/dash-if-uhd#hevc-hdr-pq10';
        if (profiles.includes(hevcHDR) && (codecs.includes('hvc1.2.4.L153.B0') ||
            codecs.includes('hev1.2.4.L153.B0'))) {
            hdr = 'PQ';
        }

        const contextId = context.representation.id ?
            context.period.id + ',' + context.representation.id : '';

        /** @type {shaka.extern.Stream} */
        let stream;

        if (contextId && this.streamMap_[contextId]) {
            stream = this.streamMap_[contextId];
        } else {
            stream = {
                id: this.globalId_++,
                originalId: context.representation.id,
                groupId: null,
                createSegmentIndex: () => Promise.resolve(),
                closeSegmentIndex: () => {
                    if (stream.segmentIndex) {
                        stream.segmentIndex.release();
                        stream.segmentIndex = null;
                    }
                },
                segmentIndex: null,
                mimeType: context.representation.mimeType,
                codecs: context.representation.codecs,
                frameRate: context.representation.frameRate,
                pixelAspectRatio: context.representation.pixelAspectRatio,
                bandwidth: context.bandwidth,
                width: context.representation.width,
                height: context.representation.height,
                kind,
                // encrypted: contentProtection.drmInfos.length > 0,
                // drmInfos: contentProtection.drmInfos,
                // keyIds,
                language,
                originalLanguage: context.adaptationSet.language,
                label,
                type: context.adaptationSet.contentType,
                primary: isPrimary,
                trickModeVideo: null,
                emsgSchemeIdUris:
                    context.representation.emsgSchemeIdUris,
                roles,
                forced,
                channelsCount: context.representation.numChannels,
                audioSamplingRate: context.representation.audioSamplingRate,
                spatialAudio,
                closedCaptions,
                hdr,
                videoLayout: undefined,
                tilesLayout,
                accessibilityPurpose,
                external: false,
                fastSwitching: false,
            };
        }

        stream.createSegmentIndex = async () => {
            if (!stream.segmentIndex) {
                stream.segmentIndex = await streamInfo.generateSegmentIndex();
            }
        };

        if (contextId && context.dynamic && !this.streamMap_[contextId]) {
            this.streamMap_[contextId] = stream;
        }

        return stream;
    }

    /**
   * Verifies that a Representation has exactly one Segment* element.  Prints
   * warnings if there is a problem.
   *
   * @param {shaka.dash.DashParser.InheritanceFrame} frame
   * @return {boolean} True if the Representation is usable; otherwise return
   *   false.
   * @private
   */
    verifyRepresentation_(frame) {
        const ContentType = ManifestParserUtils.ContentType;

        let n = 0;
        n += frame.segmentBase ? 1 : 0;
        n += frame.segmentList ? 1 : 0;
        n += frame.segmentTemplate ? 1 : 0;

        if (n == 0) {
            // TODO: Extend with the list of MIME types registered to TextEngine.
            if (frame.contentType == ContentType.TEXT ||
                frame.contentType == ContentType.APPLICATION) {
                return true;
            } else {
                logger.warning(
                    'Representation does not contain a segment information source:',
                    'the Representation must contain one of SegmentBase, SegmentList,',
                    'SegmentTemplate, or explicitly indicate that it is "text".',
                    frame);
                return false;
            }
        }

        if (n != 1) {
            logger.warning(
                'Representation contains multiple segment information sources:',
                'the Representation should only contain one of SegmentBase,',
                'SegmentList, or SegmentTemplate.',
                frame);
            if (frame.segmentBase) {
                logger.info('Using SegmentBase by default.');
                frame.segmentList = null;
                frame.segmentTemplate = null;
            } else {
                assert(frame.segmentList, 'There should be a SegmentList');
                logger.info('Using SegmentList by default.');
                frame.segmentTemplate = null;
            }
        }

        return true;
    }

    /**
   * Guess the content type based on MIME type and codecs.
   *
   * @param {string} mimeType
   * @param {string} codecs
   * @return {string}
   * @private
   */
    static guessContentType_(mimeType, codecs) {
        const fullMimeType = MimeUtils.getFullType(mimeType, codecs);

        if (TextEngine.isTypeSupported(fullMimeType)) {
            // If it's supported by TextEngine, it's definitely text.
            // We don't check MediaSourceEngine, because that would report support
            // for platform-supported video and audio types as well.
            return ManifestParserUtils.ContentType.TEXT;
        }

        // Otherwise, just split the MIME type.  This handles video and audio
        // types well.
        return mimeType.split('/')[0];
    }

    /**
     * Gets the streams from the given sets or returns an empty array if disabled
     * or no streams are found.
     * @param {boolean} disabled
     * @param {!Array.<!shaka.dash.DashParser.AdaptationInfo>} adaptationSets
     * @param {string} contentType
     @private
    */
    getStreamsFromSets_(disabled, adaptationSets, contentType) {
        if (disabled || !adaptationSets.length) {
            return [];
        }

        return adaptationSets.reduce((all, part) => {
            if (part.contentType != contentType) {
                return all;
            }

            all.push(...part.streams);
            return all;
        }, []);
    }

    /**
   * Reads maxLatency and maxPlaybackRate properties from service
   * description element.
   *
   * @param {!shaka.extern.xml.Node} mpd
   * @return {?shaka.extern.ServiceDescription}
   * @private
   */
    parseServiceDescription_(mpd) {
        const elem = xml_utils.findChild(mpd, 'ServiceDescription');

        if (!elem) {
            return null;
        }

        const latencyNode = xml_utils.findChild(elem, 'Latency');
        const playbackRateNode = xml_utils.findChild(elem, 'PlaybackRate');

        if ((latencyNode && latencyNode.attributes['max']) || playbackRateNode) {
            const maxLatency = latencyNode && latencyNode.attributes['max'] ?
                parseInt(latencyNode.attributes['max'], 10) / 1000 :
                null;
            const maxPlaybackRate = playbackRateNode ?
                parseFloat(playbackRateNode.attributes['max']) :
                null;
            const minLatency = latencyNode && latencyNode.attributes['min'] ?
                parseInt(latencyNode.attributes['min'], 10) / 1000 :
                null;
            const minPlaybackRate = playbackRateNode ?
                parseFloat(playbackRateNode.attributes['min']) :
                null;

            return {
                maxLatency,
                maxPlaybackRate,
                minLatency,
                minPlaybackRate,
            };
        }

        return null;
    }

    /**
   * Parses an array of UTCTiming elements.
   *
   * @param {function():!Array.<string>} getBaseUris
   * @param {!Array.<!shaka.extern.xml.Node>} elems
   * @return {!Promise.<number>}
   * @private
   */
    async parseUtcTiming_(getBaseUris, elems) {
        const schemesAndValues = elems.map((elem) => {
            return {
                scheme: elem.attributes['schemeIdUri'],
                value: elem.attributes['value'],
            };
        });

        // If there's nothing specified in the manifest, but we have a default from
        // the config, use that.
        const clockSyncUri = this.config_.dash.clockSyncUri;
        if (!schemesAndValues.length && clockSyncUri) {
            schemesAndValues.push({
                scheme: 'urn:mpeg:dash:utc:http-head:2014',
                value: clockSyncUri,
            });
        }

        for (const sv of schemesAndValues) {
            try {
                const scheme = sv.scheme;
                const value = sv.value;
                switch (scheme) {
                    // See DASH IOP Guidelines Section 4.7
                    // https://bit.ly/DashIop3-2
                    // Some old ISO23009-1 drafts used 2012.
                    case 'urn:mpeg:dash:utc:http-head:2014':
                    case 'urn:mpeg:dash:utc:http-head:2012':
                        // eslint-disable-next-line no-await-in-loop
                        return await this.requestForTiming_(getBaseUris, value, 'HEAD');
                    case 'urn:mpeg:dash:utc:http-xsdate:2014':
                    case 'urn:mpeg:dash:utc:http-iso:2014':
                    case 'urn:mpeg:dash:utc:http-xsdate:2012':
                    case 'urn:mpeg:dash:utc:http-iso:2012':
                        // eslint-disable-next-line no-await-in-loop
                        return await this.requestForTiming_(getBaseUris, value, 'GET');
                    case 'urn:mpeg:dash:utc:direct:2014':
                    case 'urn:mpeg:dash:utc:direct:2012': {
                        const date = Date.parse(value);
                        return isNaN(date) ? 0 : (date - Date.now());
                    }

                    case 'urn:mpeg:dash:utc:http-ntp:2014':
                    case 'urn:mpeg:dash:utc:ntp:2014':
                    case 'urn:mpeg:dash:utc:sntp:2014':
                        logger.warn('NTP UTCTiming scheme is not supported');
                        break;
                    default:
                        logger.warn(
                            'Unrecognized scheme in UTCTiming element', scheme);
                        break;
                }
            } catch (e) {
                logger.warn('Error fetching time from UTCTiming elem', e.message);
            }
        }

        logger.warn(
            'A UTCTiming element should always be given in live manifests! ' +
            'This content may not play on clients with bad clocks!');
        return 0;
    }
}

module.exports = DashMpdParser;