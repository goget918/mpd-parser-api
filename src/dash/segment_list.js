const assert = require('assert')
const MpdUtils = require('./mdp_utils');
const SegmentBase = require('./segment_base');
const logger = require('../util/logger');
const { initSegmentReference, SegmentReference } = require('../media/segment_reference');
const SegmentIndex = require('../media/segment_index');
const Functional = require('../util/functional');
const ManifestParserUtils = require('../util/manifest_parser_utils');
const StringUtils = require('../util/string_utils');
const TXml = require('../util/txml');

/**
 * @summary A set of functions for parsing SegmentList elements.
 */
class SegmentList {
  /**
   * @typedef {{
   *   mediaUri: string,
  *   start: number,
  *   end: ?number
  * }}
  *
  * @property {string} mediaUri
  *   The URI of the segment.
  * @property {number} start
  *   The start byte of the segment.
  * @property {?number} end
  *   The end byte of the segment, or null.
  */
  static MediaSegment;

  /**
  * @typedef {{
  *   segmentDuration: ?number,
  *   startTime: number,
  *   startNumber: number,
  *   scaledPresentationTimeOffset: number,
  *   timeline: Array.<shaka.media.PresentationTimeline.TimeRange>,
  *   mediaSegments: !Array.<static MediaSegment>
  * }}
  * @private
  *
  * @description
  * Contains information about a SegmentList.
  *
  * @property {?number} segmentDuration
  *   The duration of the segments, if given.
  * @property {number} startTime
  *   The start time of the first segment, in seconds.
  * @property {number} startNumber
  *   The start number of the segments; 1 or greater.
  * @property {number} scaledPresentationTimeOffset
  *   The scaledPresentationTimeOffset of the representation, in seconds.
  * @property {Array.<shaka.media.PresentationTimeline.TimeRange>} timeline
  *   The timeline of the representation, if given.  Times in seconds.
  * @property {!Array.<static MediaSegment>} mediaSegments
  *   The URI and byte-ranges of the media segments.
  */
  static SegmentListInfo;
  /**
   * Creates a new StreamInfo object.
   * Updates the existing SegmentIndex, if any.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {!Object.<string, !shaka.extern.Stream>} streamMap
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @return {shaka.dash.DashParser.StreamInfo}
   */
  static createStreamInfo(context, streamMap, aesKey) {
    assert(context.representation.segmentList,
      'Should only be called with SegmentList');

    const initSegmentReference = SegmentBase.createInitSegment(
      context, SegmentList.fromInheritance_, aesKey);
    const info = SegmentList.parseSegmentListInfo_(context);

    SegmentList.checkSegmentListInfo_(context, info);

    /** @type {shaka.media.SegmentIndex} */
    let segmentIndex = null;
    let stream = null;
    if (context.period.id && context.representation.id) {
      // Only check/store the index if period and representation IDs are set.
      const id = context.period.id + ',' + context.representation.id;
      stream = streamMap[id];
      if (stream) {
        segmentIndex = stream.segmentIndex;
      }
    }

    const references = SegmentList.createSegmentReferences_(
      context.periodInfo.start, context.periodInfo.duration,
      info.startNumber, context.representation.getBaseUris, info,
      initSegmentReference, aesKey);

    const isNew = !segmentIndex;
    if (segmentIndex) {
      const start = context.presentationTimeline.getSegmentAvailabilityStart();
      segmentIndex.mergeAndEvict(references, start);
    } else {
      segmentIndex = SegmentIndex(references);
    }
    context.presentationTimeline.notifySegments(references);

    if (!context.dynamic || !context.periodInfo.isLastPeriod) {
      const periodStart = context.periodInfo.start;
      const periodEnd = context.periodInfo.duration ?
        context.periodInfo.start + context.periodInfo.duration : Infinity;
      segmentIndex.fit(periodStart, periodEnd, isNew);
    }

    if (stream) {
      stream.segmentIndex = segmentIndex;
    }

    return {
      generateSegmentIndex: () => {
        if (!segmentIndex || segmentIndex.isEmpty()) {
          segmentIndex.merge(references);
        }
        return Promise.resolve(segmentIndex);
      },
    };
  }

  /**
   * @param {?shaka.dash.DashParser.InheritanceFrame} frame
   * @return {?shaka.extern.xml.Node}
   * @private
   */
  static fromInheritance_(frame) {
    return frame.segmentList;
  }

  /**
   * Parses the SegmentList items to create an info object.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @return {static SegmentListInfo}
   * @private
   */
  static parseSegmentListInfo_(context) {
    const mediaSegments = this.parseMediaSegments_(context);
    const segmentInfo =
      MpdUtils.parseSegmentInfo(context, this.fromInheritance_);

    let startNumber = segmentInfo.startNumber;
    if (startNumber == 0) {
      logger.warning('SegmentList@startNumber must be > 0');
      startNumber = 1;
    }

    let startTime = 0;
    if (segmentInfo.segmentDuration) {
      // See DASH sec. 5.3.9.5.3
      // Don't use presentationTimeOffset for @duration.
      startTime = segmentInfo.segmentDuration * (startNumber - 1);
    } else if (segmentInfo.timeline && segmentInfo.timeline.length > 0) {
      // The presentationTimeOffset was considered in timeline creation.
      startTime = segmentInfo.timeline[0].start;
    }

    return {
      segmentDuration: segmentInfo.segmentDuration,
      startTime: startTime,
      startNumber: startNumber,
      scaledPresentationTimeOffset: segmentInfo.scaledPresentationTimeOffset,
      timeline: segmentInfo.timeline,
      mediaSegments: mediaSegments,
    };
  }

  /**
   * Checks whether a SegmentListInfo object is valid.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @param {static SegmentListInfo} info
   * @private
   */
  static checkSegmentListInfo_(context, info) {
    if (!info.segmentDuration && !info.timeline &&
      info.mediaSegments.length > 1) {
      logger.warning(
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList specifies multiple segments,',
        'but does not specify a segment duration or timeline.',
        context.representation);
      throw new Error("DASH_NO_SEGMENT_INFO");
    }

    if (!info.segmentDuration && !context.periodInfo.duration &&
      !info.timeline && info.mediaSegments.length == 1) {
      logger.warning(
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList specifies one segment,',
        'but does not specify a segment duration, period duration,',
        'or timeline.',
        context.representation);
      throw new Error("DASH_NO_SEGMENT_INFO");
    }

    if (info.timeline && info.timeline.length == 0) {
      logger.warning(
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList has an empty timeline.',
        context.representation);
      throw new Error("DASH_NO_SEGMENT_INFO");
    }
  }

  /**
   * Creates an array of segment references for the given data.
   *
   * @param {number} periodStart in seconds.
   * @param {?number} periodDuration in seconds.
   * @param {number} startNumber
   * @param {function():!Array.<string>} getBaseUris
   * @param {static SegmentListInfo} info
   * @param {shaka.media.InitSegmentReference} initSegmentReference
   * @param {shaka.extern.aesKey|undefined} aesKey
   * @return {!Array.<!shaka.media.SegmentReference>}
   * @private
   */
  static createSegmentReferences_(
    periodStart, periodDuration, startNumber, getBaseUris, info,
    initSegmentReference, aesKey) {

    let max = info.mediaSegments.length;
    if (info.timeline && info.timeline.length != info.mediaSegments.length) {
      max = Math.min(info.timeline.length, info.mediaSegments.length);
      logger.warning(
        'The number of items in the segment timeline and the number of ',
        'segment URLs do not match, truncating', info.mediaSegments.length,
        'to', max);
    }

    const timestampOffset = periodStart - info.scaledPresentationTimeOffset;
    const appendWindowStart = periodStart;
    const appendWindowEnd = periodDuration ?
      periodStart + periodDuration : Infinity;

    /** @type {!Array.<!shaka.media.SegmentReference>} */
    const references = [];
    let prevEndTime = info.startTime;
    for (let i = 0; i < max; i++) {
      const segment = info.mediaSegments[i];
      const startTime = prevEndTime;
      let endTime;

      if (info.segmentDuration != null) {
        endTime = startTime + info.segmentDuration;
      } else if (info.timeline) {
        // Ignore the timepoint start since they are continuous.
        endTime = info.timeline[i].end;
      } else {
        // If segmentDuration and timeline are null then there must
        // be exactly one segment.
        assert(
          info.mediaSegments.length == 1 && periodDuration,
          'There should be exactly one segment with a Period duration.');
        endTime = startTime + periodDuration;
      }

      let uris = null;
      const getUris = () => {
        if (uris == null) {
          uris = ManifestParserUtils.resolveUris(
            getBaseUris(), [segment.mediaUri]);
        }
        return uris;
      };
      references.push(
        new SegmentReference(
          periodStart + startTime,
          periodStart + endTime,
          getUris,
          segment.start,
          segment.end,
          initSegmentReference,
          timestampOffset,
          appendWindowStart, appendWindowEnd,
              /* partialReferences= */[],
              /* tilesLayout= */ '',
              /* tileDuration= */ null,
              /* syncTime= */ null,
          SegmentReference.Status.AVAILABLE,
          aesKey));
      prevEndTime = endTime;
    }

    return references;
  }

  /**
   * Parses the media URIs from the context.
   *
   * @param {shaka.dash.DashParser.Context} context
   * @return {!Array.<static MediaSegment>}
   * @private
   */
  static parseMediaSegments_(context) {
    /** @type {!Array.<!shaka.extern.xml.Node>} */
    const segmentLists = [
      context.representation.segmentList,
      context.adaptationSet.segmentList,
      context.period.segmentList,
    ].filter(Functional.isNotNull);

    // Search each SegmentList for one with at least one SegmentURL element,
    // select the first one, and convert each SegmentURL element to a tuple.
    return segmentLists
      .map((node) => { return TXml.findChildren(node, 'SegmentURL'); })
      .reduce((all, part) => { return all.length > 0 ? all : part; })
      .map((urlNode) => {
        if (urlNode.attributes['indexRange'] &&
          !context.indexRangeWarningGiven) {
          context.indexRangeWarningGiven = true;
          logger.warning(
            'We do not support the SegmentURL@indexRange attribute on ' +
            'SegmentList.  We only use the SegmentList@duration ' +
            'attribute or SegmentTimeline, which must be accurate.');
        }

        const uri = StringUtils.htmlUnescape(urlNode.attributes['media']);
        const range = TXml.parseAttr(
          urlNode, 'mediaRange', TXml.parseRange,
          { start: 0, end: null });
        return { mediaUri: uri, start: range.start, end: range.end };
      });
  }
};

module.exports = SegmentList;
