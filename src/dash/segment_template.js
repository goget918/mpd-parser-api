const assert = require('assert');
const MpdUtils = require('./mdp_utils');
const SegmentBase = require('./segment_base');
const logger = require('../util/logger');
const { InitSegmentReference, SegmentReference } = require('../media/segment_reference');
const { SegmentIndex } = require('../media/segment_index');
const ManifestParserUtils = require('../util/manifest_parser_utils');
const ObjectUtils = require('../util/object_utils');
const StringUtils = require('../util/string_utils');

/**
 * @summary A set of functions for parsing SegmentTemplate elements.
 */
class SegmentTemplate {
  /**
 * @typedef {{
 *   timescale: number,
  *   segmentDuration: ?number,
  *   startNumber: number,
  *   scaledPresentationTimeOffset: number,
  *   unscaledPresentationTimeOffset: number,
  *   timeline: Array.<shaka.media.PresentationTimeline.TimeRange>,
  *   mediaTemplate: ?string,
  *   indexTemplate: ?string
  * }}
  *
  * @description
  * Contains information about a SegmentTemplate.
  *
  * @property {number} timescale
  *   The time-scale of the representation.
  * @property {?number} segmentDuration
  *   The duration of the segments in seconds, if given.
  * @property {number} startNumber
  *   The start number of the segments; 1 or greater.
  * @property {number} scaledPresentationTimeOffset
  *   The presentation time offset of the representation, in seconds.
  * @property {number} unscaledPresentationTimeOffset
  *   The presentation time offset of the representation, in timescale units.
  * @property {Array.<shaka.media.PresentationTimeline.TimeRange>} timeline
  *   The timeline of the representation, if given.  Times in seconds.
  * @property {?string} mediaTemplate
  *   The media URI template, if given.
  * @property {?string} indexTemplate
  *   The index URI template, if given.
  */
  static SegmentTemplateInfo;

  /**
   * Creates a new StreamInfo object.
   * Updates the existing SegmentIndex, if any.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.dash.DashParser.RequestSegmentCallback} requestSegment
   * @param {!Object.<string, !shaka.extern.Stream>} streamMap
   * @param {boolean} isUpdate True if the manifest is being updated.
   * @param {number} segmentLimit The maximum number of segments to generate for
   *   a SegmentTemplate with fixed duration.
   * @param {!Object.<string, number>} periodDurationMap
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @return {shaka.dash.DashParser.StreamInfo}
   */
  static createStreamInfo(
    context, requestSegment, streamMap, isUpdate, segmentLimit,
    periodDurationMap, aesKey) {
    assert(context.representation.segmentTemplate,
      'Should only be called with SegmentTemplate');

    const initSegmentReference =
      SegmentTemplate.createInitSegment_(context, aesKey);

    /** @type {shaka.dash.SegmentTemplate.SegmentTemplateInfo} */
    const info = SegmentTemplate.parseSegmentTemplateInfo_(context);

    SegmentTemplate.checkSegmentTemplateInfo_(context, info);

    // Direct fields of context will be reassigned by the parser before
    // generateSegmentIndex is called.  So we must make a shallow copy first,
    // and use that in the generateSegmentIndex callbacks.
    const shallowCopyOfContext =
      ObjectUtils.shallowCloneObject(context);
    
    if (info.indexTemplate) {
      SegmentBase.checkSegmentIndexSupport(
        context, initSegmentReference);

      return {
        generateSegmentIndex: () => {
          return SegmentTemplate.generateSegmentIndexFromIndexTemplate_(
            shallowCopyOfContext, requestSegment, initSegmentReference,
            info);
        },
      };
    } else if (info.segmentDuration) {
      if (!isUpdate && context.adaptationSet.contentType !== 'image') {
        context.presentationTimeline.notifyMaxSegmentDuration(
          info.segmentDuration);
        context.presentationTimeline.notifyMinSegmentStartTime(
          context.periodInfo.start);
      }

      return {
        generateSegmentIndex: () => {
          return SegmentTemplate.generateSegmentIndexFromDuration_(
            shallowCopyOfContext, info, segmentLimit, initSegmentReference,
            periodDurationMap, aesKey);
        },
      };
    } else {
      /** @type {shaka.media.SegmentIndex} */
      let segmentIndex = null;
      let id = null;
      let stream = null;
      if (context.period.id && context.representation.id) {
        // Only check/store the index if period and representation IDs are set.
        id = context.period.id + ',' + context.representation.id;
        stream = streamMap[id];
        if (stream) {
          segmentIndex = stream.segmentIndex;
        }
      }

      const periodStart = context.periodInfo.start;
      const periodEnd = context.periodInfo.duration ? periodStart +
        context.periodInfo.duration : Infinity;

      logger.debug(`New manifest ${periodStart} - ${periodEnd}`);

      /* When to fit segments.  All refactors should honor/update this table:
       *
       * | dynamic | infinite | last   | should | notes                     |
       * |         | period   | period | fit    |                           |
       * | ------- | -------- | ------ | ------ | ------------------------- |
       * |     F   |     F    |    X   |    T   | typical VOD               |
       * |     F   |     T    |    X   |    X   | impossible: infinite VOD  |
       * |     T   |     F    |    F   |    T   | typical live, old period  |
       * |     T   |     F    |    T   |    F   | typical IPR               |
       * |     T   |     T    |    F   |    X   | impossible: old, infinite |
       * |     T   |     T    |    T   |    F   | typical live, new period  |
       */

      // We never fit the final period of dynamic content, which could be
      // infinite live (with no limit to fit to) or IPR (which would expand the
      // most recent segment to the end of the presentation).
      const shouldFit = !(context.dynamic && context.periodInfo.isLastPeriod);

      if (!segmentIndex) {
        logger.debug(`Creating TSI with end ${periodEnd}`);
        segmentIndex = new TimelineSegmentIndex(
          info,
          context.representation.id,
          context.bandwidth,
          context.representation.getBaseUris,
          periodStart,
          periodEnd,
          initSegmentReference,
          shouldFit,
          aesKey,
          context.representation.segmentSequenceCadence,
        );
      } else {
        const tsi = /** @type {!TimelineSegmentIndex} */(segmentIndex);
        tsi.appendTemplateInfo(
          info, periodStart, periodEnd, shouldFit, initSegmentReference);

        const availabilityStart =
          context.presentationTimeline.getSegmentAvailabilityStart();
        tsi.evict(availabilityStart);
      }

      // if (info.timeline && context.adaptationSet.contentType !== 'image') {
      //   const timeline = info.timeline;
      //   context.presentationTimeline.notifyTimeRange(
      //     timeline,
      //     periodStart);
      // }

      if (stream && context.dynamic) {
        stream.segmentIndex = segmentIndex;
      }

      return {
        generateSegmentIndex: () => {
          // If segmentIndex is deleted, or segmentIndex's references are
          // released by closeSegmentIndex(), we should set the value of
          // segmentIndex again.
          if (segmentIndex instanceof TimelineSegmentIndex &&
            segmentIndex.isEmpty()) {
            segmentIndex.appendTemplateInfo(info, periodStart,
              periodEnd, shouldFit, initSegmentReference);
          }
          return Promise.resolve(segmentIndex);
        },
      };
    }
  }

  /**
   * @param {?shaka.dash.DashParser.InheritanceFrame} frame
   * @return {?shaka.extern.xml.Node}
   * @private
   */
  static fromInheritance_(frame) {
    return frame.segmentTemplate;
  }

  /**
   * Parses a SegmentTemplate element into an info object.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @return {shaka.dash.SegmentTemplate.SegmentTemplateInfo}
   * @private
   */
  static parseSegmentTemplateInfo_(context) {
    const segmentInfo = MpdUtils.parseSegmentInfo(context, SegmentTemplate.fromInheritance_);
  
    const media = MpdUtils.inheritAttribute(context, SegmentTemplate.fromInheritance_, 'media');
    const index = MpdUtils.inheritAttribute(context, SegmentTemplate.fromInheritance_, 'index');
  
    return {
      segmentDuration: segmentInfo.segmentDuration,
      timescale: segmentInfo.timescale,
      startNumber: segmentInfo.startNumber,
      scaledPresentationTimeOffset: segmentInfo.scaledPresentationTimeOffset,
      unscaledPresentationTimeOffset: segmentInfo.unscaledPresentationTimeOffset,
      timeline: segmentInfo.timeline || null,
      mediaTemplate: media && StringUtils.htmlUnescape(media),
      indexTemplate: index,
    };
  }
  

  /**
   * Verifies a SegmentTemplate info object.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.dash.SegmentTemplate.SegmentTemplateInfo} info
   * @private
   */
  static checkSegmentTemplateInfo_(context, info) {
    let n = 0;
    n += info.indexTemplate ? 1 : 0;
    n += info.timeline ? 1 : 0;
    n += info.segmentDuration ? 1 : 0;

    if (n == 0) {
      logger.error(
        'SegmentTemplate does not contain any segment information:',
        'the SegmentTemplate must contain either an index URL template',
        'a SegmentTimeline, or a segment duration.',
        context.representation);
      throw new Error("DASH_NO_SEGMENT_INFO");
    } else if (n != 1) {
      logger.warning(
        'SegmentTemplate containes multiple segment information sources:',
        'the SegmentTemplate should only contain an index URL template,',
        'a SegmentTimeline or a segment duration.',
        context.representation);
      if (info.indexTemplate) {
        logger.info('Using the index URL template by default.');
        info.timeline = null;
        info.segmentDuration = null;
      } else {
        assert(info.timeline, 'There should be a timeline');
        logger.info('Using the SegmentTimeline by default.');
        info.segmentDuration = null;
      }
    }

    if (!info.indexTemplate && !info.mediaTemplate) {
      logger.error(
        'SegmentTemplate does not contain sufficient segment information:',
        'the SegmentTemplate\'s media URL template is missing.',
        context.representation);
      throw new Error("DASH_NO_SEGMENT_INFO");
    }
  }

  /**
   * Generates a SegmentIndex from an index URL template.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.dash.DashParser.RequestSegmentCallback} requestSegment
   * @param {shaka.media.InitSegmentReference} init
   * @param {shaka.dash.SegmentTemplate.SegmentTemplateInfo} info
   * @return {!Promise.<shaka.media.SegmentIndex>}
   * @private
   */
  static generateSegmentIndexFromIndexTemplate_(
    context, requestSegment, init, info) {
    assert(info.indexTemplate, 'must be using index template');
    const filledTemplate = MpdUtils.fillUriTemplate(
      info.indexTemplate, context.representation.id,
      null, null, context.bandwidth || null, null);

    const resolvedUris = ManifestParserUtils.resolveUris(
      context.representation.getBaseUris(), [filledTemplate]);

    return shaka.dash.SegmentBase.generateSegmentIndexFromUris(
      context, requestSegment, init, resolvedUris, 0, null,
      info.scaledPresentationTimeOffset);
  }

  /**
   * Generates a SegmentIndex from fixed-duration segments.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.dash.SegmentTemplate.SegmentTemplateInfo} info
   * @param {number} segmentLimit The maximum number of segments to generate.
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   * @param {!Object.<string, number>} periodDurationMap
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @return {!Promise.<shaka.media.SegmentIndex>}
   * @private
   */
  static generateSegmentIndexFromDuration_(
    context, info, segmentLimit, initSegmentReference, periodDurationMap, aesKey) {
    assert(info.mediaTemplate, 'There should be a media template with duration');
    const presentationTimeline = context.presentationTimeline;
  
    const periodStart = context.periodInfo.start;
    const periodId = context.period.id;
    const initialPeriodDuration = context.periodInfo.duration;
  
    const getPeriodEnd = () => {
      const periodDuration =
        (periodId != null && periodDurationMap[periodId]) || initialPeriodDuration;
      const periodEnd = periodDuration ?
        (periodStart + periodDuration) : Infinity;
      return periodEnd;
    };
  
    const segmentDuration = info.segmentDuration;
    assert(segmentDuration != null, 'Segment duration must not be null!');
  
    const startNumber = info.startNumber;
    const timescale = info.timescale;
  
    const template = info.mediaTemplate;
    const bandwidth = context.bandwidth || null;
    const id = context.representation.id;
    const getBaseUris = context.representation.getBaseUris;
  
    const timestampOffset = periodStart - info.scaledPresentationTimeOffset;
  
    const computeAvailablePeriodRange = () => {
      return [
        Math.max(
          presentationTimeline.getSegmentAvailabilityStart(),
          periodStart),
  
        Math.min(
          presentationTimeline.getSegmentAvailabilityEnd(),
          getPeriodEnd()),
      ];
    };
  
    const computeAvailablePositionRange = () => {
      const availablePresentationTimes = computeAvailablePeriodRange();
      assert(availablePresentationTimes.every(isFinite),
        'Available presentation times must be finite!');
      assert(availablePresentationTimes.every((x) => x >= 0),
        'Available presentation times must be positive!');
      assert(segmentDuration != null,
        'Segment duration must not be null!');
  
      const availablePeriodTimes =
        availablePresentationTimes.map((x) => x - periodStart);
      const availablePeriodPositions = [
        Math.ceil(availablePeriodTimes[0] / segmentDuration),
        Math.ceil(availablePeriodTimes[1] / segmentDuration) - 1,
      ];
  
      const availablePresentationPositions =
        availablePeriodPositions.map((x) => x + startNumber);
      return availablePresentationPositions;
    };
  
    const range = computeAvailablePositionRange();
    const minPosition = context.dynamic ?
      Math.max(range[0], range[1] - segmentLimit + 1) :
      range[0];
    const maxPosition = range[1];
  
    const references = [];
    const createReference = (position) => {
      assert(segmentDuration != null, 'Segment duration must not be null!');
      const positionWithinPeriod = position - startNumber;
      const segmentPeriodTime = positionWithinPeriod * segmentDuration;
      const segmentMediaTime = segmentPeriodTime + info.scaledPresentationTimeOffset;
  
      const getUris = () => {
        let time = segmentMediaTime * timescale;
        if (time > Number.MAX_SAFE_INTEGER) {
          time = BigInt(segmentMediaTime) * BigInt(timescale);
        }
        const mediaUri = MpdUtils.fillUriTemplate(
          template, id, position, /* subNumber= */ null, bandwidth, time);
        return ManifestParserUtils.resolveUris(getBaseUris(), [mediaUri]);
      };
  
      const segmentStart = segmentPeriodTime + periodStart;
      const trueSegmentEnd = segmentStart + segmentDuration;
      const segmentEnd = Math.min(trueSegmentEnd, getPeriodEnd());
  
      assert(segmentStart < segmentEnd,
        'Generated a segment outside of the period!');
  
      const ref = new SegmentReference(
        segmentStart,
        segmentEnd,
        getUris,
        /* startByte= */ 0,
        /* endByte= */ null,
        initSegmentReference,
        timestampOffset,
        /* appendWindowStart= */ periodStart,
        /* appendWindowEnd= */ getPeriodEnd(),
        /* partialReferences= */[],
        /* tilesLayout= */ '',
        /* tileDuration= */ null,
        /* syncTime= */ null,
        SegmentReference.Status.AVAILABLE,
        aesKey);
      ref.trueEndTime = trueSegmentEnd;
      return ref;
    };
  
    for (let position = minPosition; position <= maxPosition; ++position) {
      const reference = createReference(position);
      references.push(reference);
    }
  
    const segmentIndex = new SegmentIndex(references);
  
    const willNeedToAddReferences =
      presentationTimeline.getSegmentAvailabilityEnd() < getPeriodEnd();
    const willNeedToEvictReferences = presentationTimeline.isLive();
  
    if (willNeedToAddReferences || willNeedToEvictReferences) {
      let nextPosition = Math.max(minPosition, maxPosition + 1);
      segmentIndex.updateEvery(segmentDuration, () => {
        const availabilityStartTime =
          presentationTimeline.getSegmentAvailabilityStart();
        segmentIndex.evict(availabilityStartTime);
  
        const [_, maxPosition] = computeAvailablePositionRange();
        const references = [];
        while (nextPosition <= maxPosition) {
          const reference = createReference(nextPosition);
          references.push(reference);
          nextPosition++;
        }
  
        if (availabilityStartTime > getPeriodEnd() && !references.length) {
          return null;
        }
        return references;
      });
    }
  
    return Promise.resolve(segmentIndex);
  }
  

  /**
   * Creates an init segment reference from a context object.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @return {shaka.media.InitSegmentReference}
   * @private
   */
  static createInitSegment_(context, aesKey) {
    let initialization = MpdUtils.inheritAttribute(
      context, SegmentTemplate.fromInheritance_, 'initialization');
    if (!initialization) {
      return null;
    }
    initialization = StringUtils.htmlUnescape(initialization);

    const repId = context.representation.id;
    const bandwidth = context.bandwidth || null;
    const getBaseUris = context.representation.getBaseUris;
    const getUris = () => {
      assert(initialization, 'Should have returned earler');
      const filledTemplate = MpdUtils.fillUriTemplate(
        initialization, repId, null, null, bandwidth, null);
      const resolvedUris = ManifestParserUtils.resolveUris(
        getBaseUris(), [filledTemplate]);
      return resolvedUris;
    };
    const qualityInfo = SegmentBase.createQualityInfo(context);
    return new InitSegmentReference(
      getUris,
        /* startByte= */ 0,
        /* endByte= */ null,
      qualityInfo,
        /* timescale= */ null,
        /* segmentData= */ null,
      aesKey);
  }
};


/**
 * A SegmentIndex that returns segments references on demand from
 * a segment timeline.
 *
 * @extends shaka.media.SegmentIndex
 * @implements {shaka.util.IReleasable}
 * @implements {Iterable.<!shaka.media.SegmentReference>}
 *
 * @private
 *
 */
class TimelineSegmentIndex extends SegmentIndex {
  /**
   *
   * @param {!shaka.dash.SegmentTemplate.SegmentTemplateInfo} templateInfo
   * @param {?string} representationId
   * @param {number} bandwidth
   * @param {function():Array.<string>} getBaseUris
   * @param {number} periodStart
   * @param {number} periodEnd
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   * @param {boolean} shouldFit
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @param {number} segmentSequenceCadence
  */
  constructor(templateInfo, representationId, bandwidth, getBaseUris,
    periodStart, periodEnd, initSegmentReference, shouldFit,
    aesKey, segmentSequenceCadence) {
    super([]);

    this.templateInfo_ = templateInfo;
    this.representationId_ = representationId;
    this.bandwidth_ = bandwidth;
    this.getBaseUris_ = getBaseUris;
    this.periodStart_ = periodStart;
    this.periodEnd_ = periodEnd;
    this.initSegmentReference_ = initSegmentReference;
    this.aesKey_ = aesKey;
    this.segmentSequenceCadence_ = segmentSequenceCadence;


    if (shouldFit) {
      this.fitTimeline();
    }
  }

  /**
   * @override
   */
  getNumReferences() {
    if (this.templateInfo_) {
      return this.templateInfo_.timeline.length;
    } else {
      return 0;
    }
  }

  /**
   * @override
   */
  release() {
    super.release();
    this.templateInfo_ = null;
    // We cannot release other fields, as segment index can
    // be recreated using only template info.
  }


  /**
   * @override
   */
  evict(time) {
    if (!this.templateInfo_) {
      return;
    }
    logger.debug(`${this.representationId_} Evicting at ${time}`);
    let numToEvict = 0;
    const timeline = this.templateInfo_.timeline;

    for (let i = 0; i < timeline.length; i += 1) {
      const range = timeline[i];
      const end = range.end + this.periodStart_;
      const start = range.start + this.periodStart_;

      if (end <= time) {
        logger.debug(`Evicting ${start} - ${end}`);
        numToEvict += 1;
      } else {
        break;
      }
    }

    if (numToEvict > 0) {
      this.templateInfo_.timeline = timeline.slice(numToEvict);
      if (this.references.length >= numToEvict) {
        this.references = this.references.slice(numToEvict);
      }

      this.numEvicted_ += numToEvict;

      if (this.getNumReferences() === 0) {
        this.release();
      }
    }
  }

  /**
   * Merge new template info
   * @param {shaka.dash.SegmentTemplate.SegmentTemplateInfo} info
   * @param {number} periodStart
   * @param {number} periodEnd
   * @param {boolean} shouldFit
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   */
  appendTemplateInfo(info, periodStart, periodEnd, shouldFit,
    initSegmentReference) {
    this.initSegmentReference_ = initSegmentReference;
    if (!this.templateInfo_) {
      this.templateInfo_ = info;
      this.periodStart_ = periodStart;
      this.periodEnd_ = periodEnd;
    } else {
      const currentTimeline = this.templateInfo_.timeline;

      this.templateInfo_.mediaTemplate = info.mediaTemplate;

      // Append timeline
      const lastCurrentEntry = currentTimeline[currentTimeline.length - 1];
      const newEntries = info.timeline.filter((entry) => {
        return entry.start >= lastCurrentEntry.end;
      });

      if (newEntries.length > 0) {
        logger.debug(`Appending ${newEntries.length} entries`);
        this.templateInfo_.timeline.push(...newEntries);
      }

      if (this.periodEnd_ !== periodEnd) {
        this.periodEnd_ = periodEnd;
      }
    }

    if (shouldFit) {
      this.fitTimeline();
    }
  }

  /**
   *
   * @param {number} time
   */
  isBeforeFirstEntry(time) {
    const hasTimeline = this.templateInfo_ &&
      this.templateInfo_.timeline && this.templateInfo_.timeline.length;

    if (hasTimeline) {
      const timeline = this.templateInfo_.timeline;
      return time < timeline[0].start + this.periodStart_;
    } else {
      return false;
    }
  }

  /**
   * Fit timeline entries to period boundaries
   */
  fitTimeline() {
    if (this.getIsImmutable()) {
      return;
    }
    const timeline = this.templateInfo_.timeline;
    while (timeline.length) {
      const lastTimePeriod = timeline[timeline.length - 1];
      if (lastTimePeriod.start >= this.periodEnd_) {
        timeline.pop();
      } else {
        break;
      }
    }

    this.evict(this.periodStart_);

    // Do NOT adjust last range to match period end! With high precision
    // timestamps several recalculations may give wrong results on less precise
    // platforms. To mitigate that, we're using cached |periodEnd_| value in
    // find/get() methods whenever possible.
  }

  /**
   * @override
   */
  find(time) {
    logger.debug(`Find ${time}`);

    if (this.isBeforeFirstEntry(time)) {
      return this.numEvicted_;
    }

    if (!this.templateInfo_) {
      return null;
    }

    const timeline = this.templateInfo_.timeline;

    // Early exit if the time isn't within this period
    if (time < this.periodStart_ || time >= this.periodEnd_) {
      return null;
    }

    const lastIndex = timeline.length - 1;

    for (let i = 0; i < timeline.length; i++) {
      const range = timeline[i];
      const start = range.start + this.periodStart_;
      // A rounding error can cause /time/ to equal e.endTime or fall in between
      // the references by a fraction of a second. To account for this, we use
      // the start of the next segment as /end/, unless this is the last
      // reference, in which case we use the period end as the /end/
      let end;

      if (i < lastIndex) {
        end = timeline[i + 1].start + this.periodStart_;
      } else if (this.periodEnd_ === Infinity) {
        end = range.end + this.periodStart_;
      } else {
        end = this.periodEnd_;
      }

      if ((time >= start) && (time < end)) {
        return i + this.numEvicted_;
      }
    }

    return null;
  }

  /**
   * @override
   */
  get(position) {
    const correctedPosition = position - this.numEvicted_;
    if (correctedPosition < 0 ||
      correctedPosition >= this.getNumReferences() || !this.templateInfo_) {
      return null;
    }

    let ref = this.references[correctedPosition];

    if (!ref) {
      const mediaTemplate = this.templateInfo_.mediaTemplate;
      const range = this.templateInfo_.timeline[correctedPosition];
      const segmentReplacement = range.segmentPosition;
      const timeReplacement = this.templateInfo_
        .unscaledPresentationTimeOffset + range.unscaledStart;
      const timestampOffset = this.periodStart_ -
        this.templateInfo_.scaledPresentationTimeOffset;
      const trueSegmentEnd = this.periodStart_ + range.end;
      let segmentEnd = trueSegmentEnd;
      if (correctedPosition === this.getNumReferences() - 1 &&
        this.periodEnd_ !== Infinity) {
        segmentEnd = this.periodEnd_;
      }

      const partialSegmentRefs = [];

      const partialDuration = (range.end - range.start) / range.partialSegments;

      for (let i = 0; i < range.partialSegments; i++) {
        const start = range.start + partialDuration * i;
        const end = start + partialDuration;
        const subNumber = i + 1;
        let uris = null;
        const getPartialUris = () => {
          if (!this.templateInfo_) {
            return [];
          }
          if (uris == null) {
            uris = TimelineSegmentIndex.createUris_(
              this.templateInfo_.mediaTemplate,
              this.representationId_,
              segmentReplacement,
              this.bandwidth_,
              timeReplacement,
              subNumber,
              this.getBaseUris_);
          }
          return uris;
        };
        const partial = new SegmentReference(
          this.periodStart_ + start,
          this.periodStart_ + end,
          getPartialUris,
            /* startByte= */ 0,
            /* endByte= */ null,
          this.initSegmentReference_,
          timestampOffset,
          this.periodStart_,
          this.periodEnd_,
            /* partialReferences= */[],
            /* tilesLayout= */ '',
            /* tileDuration= */ null,
            /* syncTime= */ null,
          SegmentReference.Status.AVAILABLE,
          this.aesKey_);
        if (this.segmentSequenceCadence_ == 0) {
          if (i > 0) {
            partial.markAsNonIndependent();
          }
        } else if ((i % this.segmentSequenceCadence_) != 0) {
          partial.markAsNonIndependent();
        }
        partialSegmentRefs.push(partial);
      }

      const createUrisCb = () => {
        if (range.partialSegments > 0) {
          return [];
        }
        return TimelineSegmentIndex
          .createUris_(
            mediaTemplate,
            this.representationId_,
            segmentReplacement,
            this.bandwidth_,
            timeReplacement,
                /* subNumber= */ null,
            this.getBaseUris_,
          );
      };

      ref = new SegmentReference(
        this.periodStart_ + range.start,
        segmentEnd,
        createUrisCb,
          /* startByte= */ 0,
          /* endByte= */ null,
        this.initSegmentReference_,
        timestampOffset,
        this.periodStart_,
        this.periodEnd_,
        partialSegmentRefs,
          /* tilesLayout= */ '',
          /* tileDuration= */ null,
          /* syncTime= */ null,
        SegmentReference.Status.AVAILABLE,
        this.aesKey_,
          /* allPartialSegments= */ range.partialSegments > 0);
      ref.trueEndTime = trueSegmentEnd;
      this.references[correctedPosition] = ref;
    }

    return ref;
  }

  /**
   * Fill in a specific template with values to get the segment uris
   *
   * @return {!Array.<string>}
   * @private
   */
  static createUris_(mediaTemplate, repId, segmentReplacement,
    bandwidth, timeReplacement, subNumber, getBaseUris) {
    const mediaUri = MpdUtils.fillUriTemplate(
      mediaTemplate, repId,
      segmentReplacement, subNumber, bandwidth || null, timeReplacement);
    return ManifestParserUtils
      .resolveUris(getBaseUris(), [mediaUri])
      .map((g) => {
        return g.toString();
      });
  }
};

module.exports = SegmentTemplate;