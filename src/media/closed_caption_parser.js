const BufferUtils = require('../util/buffer_utils');
const DummyCaptionDecoder = require('../cea/dummy_caption_decoder');
const DummyCeaParser = require('../cea/dummy_cea_parser');


/**
 * The IClosedCaptionParser defines the interface to provide all operations for
 * parsing the closed captions embedded in Dash videos streams.
 * TODO: Remove this interface and move method definitions
 * directly to ClosedCaptonParser.
 * @interface
 * @export
 */
class IClosedCaptionParser {
  /**
   * Initialize the caption parser. This should be called only once.
   * @param {BufferSource} initSegment
   */
  init(initSegment) { }

  /**
   * Parses embedded CEA closed captions and interacts with the underlying
   * CaptionStream, and calls the callback function when there are closed
   * captions.
   *
   * @param {BufferSource} mediaFragment
   * @return {!Array<!shaka.extern.ICaptionDecoder.ClosedCaption>}
   * An array of parsed closed captions.
   */
  parseFrom(mediaFragment) { }

  /**
   * Resets the CaptionStream.
   */
  reset() { }

  /**
   * Returns the streams that the CEA decoder found.
   * @return {!Array.<string>}
   */
  getStreams() { }
};

/**
 * Closed Caption Parser provides all operations for parsing the closed captions
 * embedded in Dash videos streams.
 *
 * @implements {shaka.media.IClosedCaptionParser}
 * @final
 * @export
 */
class ClosedCaptionParser {

  /** @private {!Object<string, shaka.extern.CeaParserPlugin>} */
  static parserMap_ = {};

  /** @private {?shaka.extern.CaptionDecoderPlugin} */
  static decoderFactory_ = null;
  /**
   * @param {string} mimeType
   */
  constructor(mimeType) {
    /** @private {!shaka.extern.ICeaParser} */
    this.ceaParser_ = new DummyCeaParser();

    const parserFactory = ClosedCaptionParser.findParser(mimeType.toLowerCase());
    if (parserFactory) {
      this.ceaParser_ = parserFactory();
    }

    /**
     * Decoder for decoding CEA-X08 data from closed caption packets.
     * @private {!shaka.extern.ICaptionDecoder}
     */
    this.ceaDecoder_ = new DummyCaptionDecoder();

    const decoderFactory = ClosedCaptionParser.findDecoder();
    if (decoderFactory) {
      this.ceaDecoder_ = decoderFactory();
    }
  }

  /**
   * @override
   */
  init(initSegment) {
    this.ceaParser_.init(initSegment);
  }

  /**
   * @override
   */
  parseFrom(mediaFragment) {
    // Parse the fragment.
    const captionPackets = this.ceaParser_.parse(mediaFragment);

    // Extract the caption packets for decoding.
    for (const captionPacket of captionPackets) {
      const uint8ArrayData = BufferUtils.toUint8(captionPacket.packet);
      if (uint8ArrayData.length > 0) {
        this.ceaDecoder_.extract(uint8ArrayData, captionPacket.pts);
      }
    }

    // Decode and return the parsed captions.
    return this.ceaDecoder_.decode();
  }

  /**
   * @override
   */
  reset() {
    this.ceaDecoder_.clear();
  }

  /**
   * @override
   */
  getStreams() {
    return this.ceaDecoder_.getStreams();
  }

  /**
   * @param {string} mimeType
   * @param {!shaka.extern.CeaParserPlugin} plugin
   * @export
   */
  static registerParser(mimeType, plugin) {
    this.parserMap_[mimeType] = plugin;
  }

  /**
   * @param {string} mimeType
   * @export
   */
  static unregisterParser(mimeType) {
    delete this.parserMap_[mimeType];
  }

  /**
   * @param {string} mimeType
   * @return {?shaka.extern.CeaParserPlugin}
   * @export
   */
  static findParser(mimeType) {
    return this.parserMap_[mimeType];
  }

  /**
   * @param {!shaka.extern.CaptionDecoderPlugin} plugin
   * @export
   */
  static registerDecoder(plugin) {
    this.decoderFactory_ = plugin;
  }

  /**
   * @export
   */
  static unregisterDecoder() {
    this.decoderFactory_ = null;
  }

  /**
   * @return {?shaka.extern.CaptionDecoderPlugin}
   * @export
   */
  static findDecoder() {
    return this.decoderFactory_;
  }
};


module.exports = { ClosedCaptionParser, IClosedCaptionParser };
