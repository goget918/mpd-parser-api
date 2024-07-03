const assert = require('assert');
const ManifestParserUtils = require('../util/manifest_parser_utils');
const logger = require('../util/logger');
const Functional = require('../util/functional');
const xml_utils = require('../util/xml_utils');
const AbortableOperation = require('../util/abortable_operation');
const { time } = require('console');


/**
 * @summary MPD processing utility functions.
 */
class MpdUtils {

    /**
 * @typedef {{
 *   timescale: number,
    *   segmentDuration: ?number,
    *   startNumber: number,
    *   scaledPresentationTimeOffset: number,
    *   unscaledPresentationTimeOffset: number,
    *   timeline: Array.<shaka.media.PresentationTimeline.TimeRange>
    * }}
    *
    * @description
    * Contains common information between SegmentList and SegmentTemplate items.
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
    */
    static SegmentInfo;


    static XlinkNamespaceUri_ = 'http://www.w3.org/1999/xlink';
    /**
     * Fills a SegmentTemplate URI template.  This function does not validate the
     * resulting URI.
     *
     * @param {string} uriTemplate
     * @param {?string} representationId
     * @param {?number} number
     * @param {?number} subNumber
     * @param {?number} bandwidth
     * @param {?(number|bigint)} time
     * @return {string} A URI string.
     * @see ISO/IEC 23009-1:2014 section 5.3.9.4.4
     */
    static fillUriTemplate(
        uriTemplate, representationId, number, subNumber, bandwidth, time) {
        /** @type {!Object.<string, ?number|?string>} */
        const valueTable = {
            'RepresentationID': representationId,
            'Number': number,
            'SubNumber': subNumber,
            'Bandwidth': bandwidth,
            'Time': time,
        };

        const re = /\$(RepresentationID|Number|SubNumber|Bandwidth|Time)?(?:%0([0-9]+)([diouxX]))?\$/g;  // eslint-disable-line max-len
        const uri = uriTemplate.replace(re, (match, name, widthStr, format) => {
            if (match == '$$') {
                return '$';
            }

            let value = valueTable[name];
            assert(value !== undefined, 'Unrecognized identifier');

            // Note that |value| may be 0 or ''.
            if (value == null) {
                logger.warning(
                    'URL template does not have an available substitution for ',
                    'identifier "' + name + '":',
                    uriTemplate);
                return match;
            }

            if (name == 'RepresentationID' && widthStr) {
                logger.warning(
                    'URL template should not contain a width specifier for identifier',
                    '"RepresentationID":',
                    uriTemplate);
                widthStr = undefined;
            }

            if (name == 'Time') {
                if (typeof value != 'bigint') {
                    assert(typeof value == 'number',
                        'Time value should be a number or bigint!');
                    if (Math.abs(value - Math.round(value)) >= 0.2) {
                        logger.alwaysWarn(
                            'Calculated $Time$ values must be close to integers');
                    }
                    value = Math.round(value);
                }
            }

            /** @type {string} */
            let valueString;
            switch (format) {
                case undefined:  // Happens if there is no format specifier.
                case 'd':
                case 'i':
                case 'u':
                    valueString = value.toString();
                    break;
                case 'o':
                    valueString = value.toString(8);
                    break;
                case 'x':
                    valueString = value.toString(16);
                    break;
                case 'X':
                    valueString = value.toString(16).toUpperCase();
                    break;
                default:
                    assert(false, 'Unhandled format specifier');
                    valueString = value.toString();
                    break;
            }

            // Create a padding string.
            const width = parseInt(widthStr, 10) || 1;
            const paddingSize = Math.max(0, width - valueString.length);
            const padding = (new Array(paddingSize + 1)).join('0');

            return padding + valueString;
        });

        return uri;
    }

    /**
     * Expands a SegmentTimeline into an array-based timeline.  The results are in
     * seconds.
     *
     * @param {!shaka.extern.xml.Node} segmentTimeline
     * @param {number} timescale
     * @param {number} unscaledPresentationTimeOffset
     * @param {number} periodDuration The Period's duration in seconds.
     *   Infinity indicates that the Period continues indefinitely.
     * @param {number} startNumber
     * @return {!Array.<shaka.media.PresentationTimeline.TimeRange>}
     */
    static createTimeline(
        segmentTimeline, timescale, unscaledPresentationTimeOffset,
        periodDuration, startNumber) {
        assert(
            timescale > 0 && timescale < Infinity,
            'timescale must be a positive, finite integer');
        assert(
            periodDuration > 0, 'period duration must be a positive integer');

        // Alias.
        const timePoints = xml_utils.findChildren(segmentTimeline, 'S');

        /** @type {!Array.<shaka.media.PresentationTimeline.TimeRange>} */
        const timeline = [];
        let lastEndTime = -unscaledPresentationTimeOffset;

        for (let i = 0; i < timePoints.length; ++i) {
            const timePoint = timePoints[i];
            const next = timePoints[i + 1];
            let t = xml_utils.parseAttr(timePoint, 't', xml_utils.parseNonNegativeInt);
            const d =
                xml_utils.parseAttr(timePoint, 'd', xml_utils.parseNonNegativeInt);
            const r = xml_utils.parseAttr(timePoint, 'r', xml_utils.parseInt);

            const k = xml_utils.parseAttr(timePoint, 'k', xml_utils.parseInt);

            const partialSegments = k || 0;

            // Adjust the start time to account for the presentation time offset.
            if (t != null) {
                t -= unscaledPresentationTimeOffset;
            }

            if (!d) {
                logger.warning(
                    '"S" element must have a duration:',
                    'ignoring the remaining "S" elements.', timePoint);
                return timeline;
            }

            let startTime = t != null ? t : lastEndTime;

            let repeat = r || 0;
            if (repeat < 0) {
                if (next) {
                    const nextStartTime =
                        xml_utils.parseAttr(next, 't', xml_utils.parseNonNegativeInt);
                    if (nextStartTime == null) {
                        logger.warning(
                            'An "S" element cannot have a negative repeat',
                            'if the next "S" element does not have a valid start time:',
                            'ignoring the remaining "S" elements.', timePoint);
                        return timeline;
                    } else if (startTime >= nextStartTime) {
                        logger.warning(
                            'An "S" element cannot have a negative repeatif its start ',
                            'time exceeds the next "S" element\'s start time:',
                            'ignoring the remaining "S" elements.', timePoint);
                        return timeline;
                    }
                    repeat = Math.ceil((nextStartTime - startTime) / d) - 1;
                } else {
                    if (periodDuration == Infinity) {
                        // The DASH spec. actually allows the last "S" element to have a
                        // negative repeat value even when the Period has an infinite
                        // duration.  No one uses this feature and no one ever should,
                        // ever.
                        logger.warning(
                            'The last "S" element cannot have a negative repeat',
                            'if the Period has an infinite duration:',
                            'ignoring the last "S" element.', timePoint);
                        return timeline;
                    } else if (startTime / timescale >= periodDuration) {
                        logger.warning(
                            'The last "S" element cannot have a negative repeat',
                            'if its start time exceeds the Period\'s duration:',
                            'igoring the last "S" element.', timePoint);
                        return timeline;
                    }
                    repeat = Math.ceil((periodDuration * timescale - startTime) / d) - 1;
                }
            }

            // The end of the last segment may be before the start of the current
            // segment (a gap) or after the start of the current segment (an
            // overlap). If there is a gap/overlap then stretch/compress the end of
            // the last segment to the start of the current segment.
            //
            // Note: it is possible to move the start of the current segment to the
            // end of the last segment, but this would complicate the computation of
            // the $Time$ placeholder later on.
            if ((timeline.length > 0) && (startTime != lastEndTime)) {
                const delta = startTime - lastEndTime;

                if (Math.abs(delta / timescale) >=
                    ManifestParserUtils.GAP_OVERLAP_TOLERANCE_SECONDS) {
                    logger.info(`SegmentTimeline contains a large gap/overlap: the content may have errors in it. ${timePoint}`);
                }

                timeline[timeline.length - 1].end = startTime / timescale;
            }

            for (let j = 0; j <= repeat; ++j) {
                const endTime = startTime + d;
                const item = {
                    start: startTime / timescale,
                    end: endTime / timescale,
                    unscaledStart: startTime,
                    partialSegments: partialSegments,
                    segmentPosition: timeline.length + startNumber,
                };
                timeline.push(item);

                startTime = endTime;
                lastEndTime = endTime;
            }
        }

        return timeline;
    }

    /**
     * Parses common segment info for SegmentList and SegmentTemplate.
     *
     * @param {shaka.dash.DashParser.Context} context
     * @param {function(?shaka.dash.DashParser.InheritanceFrame):
     *   ?shaka.extern.xml.Node} callback
     *   Gets the element that contains the segment info.
     * @return {shaka.dash.MpdUtils.SegmentInfo}
     */
    static parseSegmentInfo(context, callback) {
        assert(
            callback(context.representation),
            'There must be at least one element of the given type.');

        const timescaleStr =
            this.inheritAttribute(context, callback, 'timescale');
        let timescale = 1;
        if (timescaleStr) {
            timescale = xml_utils.parsePositiveInt(timescaleStr) || 1;
        }

        const durationStr =
            this.inheritAttribute(context, callback, 'duration');
        let segmentDuration = xml_utils.parsePositiveInt(durationStr || '');
        const ContentType = ManifestParserUtils.ContentType;
        // TODO: The specification is not clear, check this once it is resolved:
        // https://github.com/Dash-Industry-Forum/DASH-IF-IOP/issues/404
        if (context.representation.contentType == ContentType.IMAGE) {
            segmentDuration = xml_utils.parseFloat(durationStr || '');
        }
        if (segmentDuration) {
            segmentDuration /= timescale;
        }

        const startNumberStr =
            this.inheritAttribute(context, callback, 'startNumber');
        const unscaledPresentationTimeOffset =
            Number(this.inheritAttribute(context, callback,
                'presentationTimeOffset')) || 0;
        let startNumber = xml_utils.parseNonNegativeInt(startNumberStr || '');
        if (startNumberStr == null || startNumber == null) {
            startNumber = 1;
        }

        const timelineNode =
            this.inheritChild(context, callback, 'SegmentTimeline');
        /** @type {Array.<shaka.media.PresentationTimeline.TimeRange>} */
        let timeline = null;
        if (timelineNode) {
            timeline = this.createTimeline(
                timelineNode, timescale, unscaledPresentationTimeOffset,
                context.periodInfo.duration || Infinity, startNumber);
        }

        const scaledPresentationTimeOffset =
            (unscaledPresentationTimeOffset / timescale) || 0;
        return {
            timescale: timescale,
            segmentDuration: segmentDuration,
            startNumber: startNumber,
            scaledPresentationTimeOffset: scaledPresentationTimeOffset,
            unscaledPresentationTimeOffset: unscaledPresentationTimeOffset,
            timeline: timeline,
        };
    }

    /**
     * Parses common attributes for Representation, AdaptationSet, and Period.
     * @param {shaka.dash.DashParser.Context} context
     * @param {function(?shaka.dash.DashParser.InheritanceFrame):
     *    ?shaka.extern.xml.Node} callback
     * @return {!Array.<!shaka.extern.xml.Node>}
      */
    static getNodes(context, callback) {
        assert(
            callback(context.representation),
            'There must be at least one element of the given type',
        );

        return [
            callback(context.representation),
            callback(context.adaptationSet),
            callback(context.period),
        ].filter(Functional.isNotNull);
    }

    /**
     * Searches the inheritance for a Segment* with the given attribute.
     *
     * @param {shaka.dash.DashParser.Context} context
     * @param {function(?shaka.dash.DashParser.InheritanceFrame):
     *   ?shaka.extern.xml.Node} callback
     *   Gets the Element that contains the attribute to inherit.
     * @param {string} attribute
     * @return {?string}
     */
    static inheritAttribute(context, callback, attribute) {
        const nodes = this.getNodes(context, callback);

        let result = null;
        for (const node of nodes) {
            result = node.attributes[attribute];
            if (result) {
                break;
            }
        }
        return result;
    }

    /**
     * Searches the inheritance for a Segment* with the given child.
     *
     * @param {shaka.dash.DashParser.Context} context
     * @param {function(?shaka.dash.DashParser.InheritanceFrame):
     *   ?shaka.extern.xml.Node} callback
     *   Gets the Element that contains the child to inherit.
     * @param {string} child
     * @return {?shaka.extern.xml.Node}
     */
    static inheritChild(context, callback, child) {
        const nodes = this.getNodes(context, callback);

        let result = null;
        for (const node of nodes) {
            result = xml_utils.findChild(node, child);
            if (result) {
                break;
            }
        }
        return result;
    }

    // /**
    //  * Follow the xlink link contained in the given element.
    //  * It also strips the xlink properties off of the element,
    //  * even if the process fails.
    //  *
    //  * @param {!shaka.extern.xml.Node} element
    //  * @param {!shaka.extern.RetryParameters} retryParameters
    //  * @param {boolean} failGracefully
    //  * @param {string} baseUri
    //  * @param {!shaka.net.NetworkingEngine} networkingEngine
    //  * @param {number} linkDepth
    //  * @return {!shaka.util.AbortableOperation.<!shaka.extern.xml.Node>}
    //  * @private
    //  */
    // static handleXlinkInElement_(
    //     element, retryParameters, failGracefully, baseUri, networkingEngine,
    //     linkDepth) {
    //     const NS = this.XlinkNamespaceUri_;

    //     const xlinkHref = xml_utils.getAttributeNS(element, NS, 'href');
    //     const xlinkActuate =
    //         xml_utils.getAttributeNS(element, NS, 'actuate') || 'onRequest';

    //     // Remove the xlink properties, so it won't download again
    //     // when re-processed.
    //     for (const key of Object.keys(element.attributes)) {
    //         const segs = key.split(':');
    //         const namespace = xml_utils.getKnownNameSpace(NS);
    //         if (segs[0] == namespace) {
    //             delete element.attributes[key];
    //         }
    //     }

    //     if (linkDepth >= 5) {
    //         return AbortableOperation.failed(new Error("Dash Xlink depth limit"));
    //     }

    //     if (xlinkActuate != 'onLoad') {
    //         // Only xlink:actuate="onLoad" is supported.
    //         // When no value is specified, the assumed value is "onRequest".
    //         return AbortableOperation.failed(new Error("DASH_UNSUPPORTED_XLINK_ACTUATE"));
    //     }

    //     // Resolve the xlink href, in case it's a relative URL.
    //     const uris = ManifestParserUtils.resolveUris([baseUri], [xlinkHref]);

    //     // Load in the linked elements.
    //     const requestType = shaka.net.NetworkingEngine.RequestType.MANIFEST;
    //     const request =
    //         shaka.net.NetworkingEngine.makeRequest(uris, retryParameters);

    //     const requestOperation = networkingEngine.request(requestType, request);
    //     // The interface is abstract, but we know it was implemented with the
    //     // more capable internal class.
    //     assert(
    //         requestOperation instanceof shaka.util.AbortableOperation,
    //         'Unexpected implementation of IAbortableOperation!');
    //     // Satisfy the compiler with a cast.
    //     const networkOperation =
    // /** @type {!shaka.util.AbortableOperation.<shaka.extern.Response>} */ (
    //             requestOperation);

    //     // Chain onto that operation.
    //     return networkOperation.chain(
    //         (response) => {
    //             // This only supports the case where the loaded xml has a single
    //             // top-level element.  If there are multiple roots, it will be
    //             // rejected.
    //             const rootElem =
    //                 xml_utils.parseXml(response.data, element.tagName);
    //             if (!rootElem) {
    //                 // It was not valid XML.
    //                 return shaka.util.AbortableOperation.failed(new Error(
    //                     Error.Severity.CRITICAL, Error.Category.MANIFEST,
    //                     Error.Code.DASH_INVALID_XML, xlinkHref));
    //             }

    //             // Now that there is no other possibility of the process erroring,
    //             // the element can be changed further.

    //             // Remove the current contents of the node.
    //             element.children = [];

    //             // Move the children of the loaded xml into the current element.
    //             while (rootElem.children.length) {
    //                 const child = rootElem.children.shift();
    //                 if (xml_utils.isNode(child)) {
    //                     child.parent = element;
    //                 }
    //                 element.children.push(child);
    //             }

    //             // Move the attributes of the loaded xml into the current element.
    //             for (const key of Object.keys(rootElem.attributes)) {
    //                 element.attributes[key] = rootElem.attributes[key];
    //             }

    //             return shaka.dash.MpdUtils.processXlinks(
    //                 element, retryParameters, failGracefully, uris[0],
    //                 networkingEngine, linkDepth + 1);
    //         });
    // }

    // /**
    //  * Filter the contents of a node recursively, replacing xlink links
    //  * with their associated online data.
    //  *
    //  * @param {!shaka.extern.xml.Node} element
    //  * @param {!shaka.extern.RetryParameters} retryParameters
    //  * @param {boolean} failGracefully
    //  * @param {string} baseUri
    //  * @param {!shaka.net.NetworkingEngine} networkingEngine
    //  * @param {number=} linkDepth, default set to 0
    //  * @return {!shaka.util.AbortableOperation.<!shaka.extern.xml.Node>}
    //  */
    // static processXlinks(
    //     element, retryParameters,
    //     failGracefully, baseUri, networkingEngine,
    //     linkDepth = 0) {
    //     const MpdUtils = shaka.dash.MpdUtils;
    //     const xml_utils = shaka.util.xml_utils;
    //     const NS = MpdUtils.XlinkNamespaceUri_;

    //     if (xml_utils.getAttributeNS(element, NS, 'href')) {
    //         let handled = MpdUtils.handleXlinkInElement_(
    //             element, retryParameters, failGracefully,
    //             baseUri, networkingEngine, linkDepth);
    //         if (failGracefully) {
    //             // Catch any error and go on.
    //             handled = handled.chain(undefined, (error) => {
    //                 // handleXlinkInElement_ strips the xlink properties off of the
    //                 // element even if it fails, so calling processXlinks again will
    //                 // handle whatever contents the element natively has.
    //                 return MpdUtils.processXlinks(
    //                     element, retryParameters, failGracefully, baseUri,
    //                     networkingEngine, linkDepth);
    //             });
    //         }
    //         return handled;
    //     }

    //     const childOperations = [];
    //     for (const child of shaka.util.xml_utils.getChildNodes(element)) {
    //         const resolveToZeroString = 'urn:mpeg:dash:resolve-to-zero:2013';
    //         if (xml_utils.getAttributeNS(child, NS, 'href') == resolveToZeroString) {
    //             // This is a 'resolve to zero' code; it means the element should
    //             // be removed, as specified by the mpeg-dash rules for xlink.
    //             element.children = element.children.filter(
    //                 (elem) => elem !== child);
    //         } else if (child.tagName != 'SegmentTimeline') {
    //             // Don't recurse into a SegmentTimeline since xlink attributes
    //             // aren't valid in there and looking at each segment can take a long
    //             // time with larger manifests.

    //             // Replace the child with its processed form.
    //             childOperations.push(shaka.dash.MpdUtils.processXlinks(
    //         /** @type {!shaka.extern.xml.Node} */(child),
    //                 retryParameters, failGracefully,
    //                 baseUri, networkingEngine, linkDepth));
    //         }
    //     }

    //     return shaka.util.AbortableOperation.all(childOperations).chain(() => {
    //         return element;
    //     });
    // }
};

module.exports = MpdUtils;