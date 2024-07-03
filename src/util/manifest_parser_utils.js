const url = require('url');
const functional = require('./functional');

class ManifestParserUtils {
    /**
 * @enum {string}
 */
    static ContentType = {
        VIDEO: 'video',
        AUDIO: 'audio',
        TEXT: 'text',
        IMAGE: 'image',
        APPLICATION: 'application',
    };


    /**
     * @enum {string}
     */
    static TextStreamKind = {
        SUBTITLE: 'subtitle',
        CLOSED_CAPTION: 'caption',
    };


    /**
     * Specifies how tolerant the player is of inaccurate segment start times and
     * end times within a manifest. For example, gaps or overlaps between segments
     * in a SegmentTimeline which are greater than or equal to this value will
     * result in a warning message.
     *
     * @const {number}
     */
    static GAP_OVERLAP_TOLERANCE_SECONDS = 1 / 15;


    /**
     * A list of regexps to detect well-known video codecs.
     *
     * @const {!Array.<!RegExp>}
     * @private
     */
    static VIDEO_CODEC_REGEXPS_ = [
        /^avc/,
        /^hev/,
        /^hvc/,
        /^vvc/,
        /^vvi/,
        /^vp0?[89]/,
        /^av01/,
        /^dvh/, // Dolby Vision based in HEVC
        /^dva/, // Dolby Vision based in AVC
        /^dav/, // Dolby Vision based in AV1
    ];


    /**
     * A list of regexps to detect well-known audio codecs.
     *
     * @const {!Array.<!RegExp>}
     * @private
     */
    static AUDIO_CODEC_REGEXPS_ = [
        /^vorbis$/,
        /^Opus$/, // correct codec string according to RFC 6381 section 3.3
        /^opus$/, // some manifests wrongfully use this
        /^fLaC$/, // correct codec string according to RFC 6381 section 3.3
        /^flac$/, // some manifests wrongfully use this
        /^mp4a/,
        /^[ae]c-3$/,
        /^ac-4$/,
        /^dts[cex]$/, // DTS Digital Surround (dtsc), DTS Express (dtse), DTS:X (dtsx)
    ];


    /**
     * A list of regexps to detect well-known text codecs.
     *
     * @const {!Array.<!RegExp>}
     * @private
     */
    static TEXT_CODEC_REGEXPS_ = [
        /^vtt$/,
        /^wvtt/,
        /^stpp/,
    ];


    /**
     * @const {!Object.<string, !Array.<!RegExp>>}
     */
    static CODEC_REGEXPS_BY_CONTENT_TYPE_ = {
        'audio': this.AUDIO_CODEC_REGEXPS_,
        'video': this.VIDEO_CODEC_REGEXPS_,
        'text': this.TEXT_CODEC_REGEXPS_,
    };
    /**
     * Resolves an array of relative URIs to the given base URIs. This will result
     * in M*N number of URIs.
     *
     * @param {Array.<string>} baseUris
     * @param {Array.<string>} relativeUris
     * @return {Array.<string>}
     */
    static resolveUris(baseUris, relativeUris) {
        if (relativeUris.length == 0) {
            return baseUris;
        }

        if (baseUris.length == 0) {
            return relativeUris
                .reduce(functional.collapseArrays, [])
                .map((uri) => uri.toString());
        }
        else {
            // Resolve each URI relative to each base URI, creating an Array of Arrays.
            // Then flatten the Arrays into a single Array.
            return baseUris
                .map((base) => relativeUris.map((i) => url.resolve(base, i)))
                .reduce(functional.collapseArrays, [])
                .map((uri) => uri.toString());
        }
    }
}

module.exports = ManifestParserUtils;
