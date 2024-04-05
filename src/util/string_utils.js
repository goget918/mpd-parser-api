const BufferUtils = require('./buffer_utils');
const Lazy = require("./lazy");
const assert = require('assert');
const logger = require('./logger');

class StringUtils {
    static fromCharCodeImpl_ = new Lazy(() => {
        /** @param {number} size @return {boolean} */
        const supportsChunkSize = (size) => {
            try {
                // The compiler will complain about suspicious value if this isn't
                // stored in a variable and used.
                const buffer = new Uint8Array(size);

                // This can't use the spread operator, or it blows up on Xbox One.
                // So we use apply() instead, which is normally not allowed.
                // See issue #2186 for more details.
                // eslint-disable-next-line no-restricted-syntax
                const foo = String.fromCharCode.apply(null, buffer);
                assert(foo, 'Should get value');
                return foo.length > 0; // Actually use "foo", so it's not compiled out.
            } catch (error) {
                return false;
            }
        };
        // Different browsers support different chunk sizes; find out the largest
        // this browser supports so we can use larger chunks on supported browsers
        // but still support lower-end devices that require small chunks.
        // 64k is supported on all major desktop browsers.
        for (let size = 64 * 1024; size > 0; size /= 2) {
            if (supportsChunkSize(size)) {
                return (buffer) => {
                    let ret = '';
                    for (let i = 0; i < buffer.length; i += size) {
                        const subArray = buffer.subarray(i, i + size);

                        // This can't use the spread operator, or it blows up on Xbox One.
                        // So we use apply() instead, which is normally not allowed.
                        // See issue #2186 for more details.
                        // eslint-disable-next-line no-restricted-syntax
                        ret += String.fromCharCode.apply(null, subArray);  // Issue #2186
                    }
                    return ret;
                };
            }
        }
        assert(false, 'Unable to create a fromCharCode method');
        return null;
    });

    /**
   * Creates a new string from the given array of char codes.
   *
   * Using String.fromCharCode.apply is risky because you can trigger stack
   * errors on very large arrays.  This breaks up the array into several pieces
   * to avoid this.
   *
   * @param {!TypedArray} array
   * @return {string}
   */
    static fromCharCode(array) {
        return this.fromCharCodeImpl_.value()(array);
    }

    /**
   * Creates a string from the given buffer as UTF-8 encoding.
   *
   * @param {?BufferSource} data
   * @return {string}
   * @export
   */
    static fromUTF8(data) {
        if (!data) {
            return '';
        }

        let uint8 = BufferUtils.toUint8(data);
        // If present, strip off the UTF-8 BOM.
        if (uint8[0] == 0xef && uint8[1] == 0xbb && uint8[2] == 0xbf) {
            uint8 = uint8.subarray(3);
        }

        // Homebrewed UTF-8 decoder based on
        // https://en.wikipedia.org/wiki/UTF-8#Encoding
        // Unlike decodeURIComponent, won't throw on bad encoding.
        // In this way, it is similar to TextDecoder.

        let decoded = '';
        for (let i = 0; i < uint8.length; ++i) {
            // By default, the "replacement character" codepoint.
            let codePoint = 0xFFFD;

            // Top bit is 0, 1-byte encoding.
            if ((uint8[i] & 0x80) == 0) {
                codePoint = uint8[i];

                // Top 3 bits of byte 0 are 110, top 2 bits of byte 1 are 10,
                // 2-byte encoding.
            } else if (uint8.length >= i + 2 &&
                (uint8[i] & 0xe0) == 0xc0 &&
                (uint8[i + 1] & 0xc0) == 0x80) {
                codePoint = ((uint8[i] & 0x1f) << 6) |
                    ((uint8[i + 1] & 0x3f));
                i += 1;  // Consume one extra byte.

                // Top 4 bits of byte 0 are 1110, top 2 bits of byte 1 and 2 are 10,
                // 3-byte encoding.
            } else if (uint8.length >= i + 3 &&
                (uint8[i] & 0xf0) == 0xe0 &&
                (uint8[i + 1] & 0xc0) == 0x80 &&
                (uint8[i + 2] & 0xc0) == 0x80) {
                codePoint = ((uint8[i] & 0x0f) << 12) |
                    ((uint8[i + 1] & 0x3f) << 6) |
                    ((uint8[i + 2] & 0x3f));
                i += 2;  // Consume two extra bytes.

                // Top 5 bits of byte 0 are 11110, top 2 bits of byte 1, 2 and 3 are 10,
                // 4-byte encoding.
            } else if (uint8.length >= i + 4 &&
                (uint8[i] & 0xf1) == 0xf0 &&
                (uint8[i + 1] & 0xc0) == 0x80 &&
                (uint8[i + 2] & 0xc0) == 0x80 &&
                (uint8[i + 3] & 0xc0) == 0x80) {
                codePoint = ((uint8[i] & 0x07) << 18) |
                    ((uint8[i + 1] & 0x3f) << 12) |
                    ((uint8[i + 2] & 0x3f) << 6) |
                    ((uint8[i + 3] & 0x3f));
                i += 3;  // Consume three extra bytes.
            }

            // JavaScript strings are a series of UTF-16 characters.
            if (codePoint <= 0xffff) {
                decoded += String.fromCharCode(codePoint);
            } else {
                // UTF-16 surrogate-pair encoding, based on
                // https://en.wikipedia.org/wiki/UTF-16#Description
                const baseCodePoint = codePoint - 0x10000;
                const highPart = baseCodePoint >> 10;
                const lowPart = baseCodePoint & 0x3ff;
                decoded += String.fromCharCode(0xd800 + highPart);
                decoded += String.fromCharCode(0xdc00 + lowPart);
            }
        }

        return decoded;
    }

    /**
   * Creates a string from the given buffer as UTF-16 encoding.
   *
   * @param {?BufferSource} data
   * @param {boolean} littleEndian
         true to read little endian, false to read big.
   * @param {boolean=} noThrow true to avoid throwing in cases where we may
   *     expect invalid input.  If noThrow is true and the data has an odd
   *     length,it will be truncated.
   * @return {string}
   * @export
   */
    static fromUTF16(data, littleEndian, noThrow) {
        if (!data) {
            return '';
        }

        if (!noThrow && data.byteLength % 2 != 0) {
            logger.error('Data has an incorrect length, must be even.');
            throw new Error('Data has an incorrect length, must be even.');
        }

        // Use a DataView to ensure correct endianness.
        const length = Math.floor(data.byteLength / 2);
        const arr = new Uint16Array(length);
        const dataView = BufferUtils.toDataView(data);
        for (let i = 0; i < length; i++) {
            arr[i] = dataView.getUint16(i * 2, littleEndian);
        }
        return this.fromCharCode(arr);
    }

    /**
   * This method converts the HTML entities &amp;, &lt;, &gt;, &quot;, &#39;,
   * &nbsp;, &lrm; and &rlm; in string to their corresponding characters.
   *
   * @param {!string} input
   * @return {string}
   */
    static htmlUnescape(input) {
        // Used to map HTML entities to characters.
        const htmlUnescapes = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#39;': '\'',
            '&apos;': '\'',
            '&nbsp;': '\u{a0}',
            '&lrm;': '\u{200e}',
            '&rlm;': '\u{200f}',
        };

        // Used to match HTML entities and HTML characters.
        const reEscapedHtml = /&(?:amp|lt|gt|quot|apos|#(0+)?39|nbsp|lrm|rlm);/g;
        const reHasEscapedHtml = RegExp(reEscapedHtml.source);
        // This check is an optimization, since replace always makes a copy
        if (input && reHasEscapedHtml.test(input)) {
            return input.replace(reEscapedHtml, (entity) => {
                // The only thing that might not match the dictionary above is the
                // single quote, which can be matched by many strings in the regex, but
                // only has a single entry in the dictionary.
                return htmlUnescapes[entity] || '\'';
            });
        }
        return input || '';
    }

    static fromBytesAutoDetect(data) {
        if (!data) {
            return '';
        }

        const uint8 = BufferUtils.toUint8(data);

        if (uint8[0] == 0xef && uint8[1] == 0xbb && uint8[2] == 0xbf) {
            return this.fromUTF8(uint8);
        } else if (uint8[0] == 0xfe && uint8[1] == 0xff) {
            return StringUtils.fromUTF16(
                uint8.subarray(2), /* littleEndian= */ false);
        } else if (uint8[0] == 0xff && uint8[1] == 0xfe) {
            return StringUtils.fromUTF16(uint8.subarray(2), /* littleEndian= */ true);
        }

        const isAscii = (i) => {
            // arr[i] >= ' ' && arr[i] <= '~';
            return uint8.byteLength <= i || (uint8[i] >= 0x20 && uint8[i] <= 0x7e);
        };

        logger.debug(
            'Unable to find byte-order-mark, making an educated guess.');
        if (uint8[0] == 0 && uint8[2] == 0) {
            return StringUtils.fromUTF16(data, /* littleEndian= */ false);
        } else if (uint8[1] == 0 && uint8[3] == 0) {
            return StringUtils.fromUTF16(data, /* littleEndian= */ true);
        } else if (isAscii(0) && isAscii(1) && isAscii(2) && isAscii(3)) {
            return StringUtils.fromUTF8(data);
        }

        throw new Error("Unable to detect Encoding");
    }
};

module.exports = StringUtils;