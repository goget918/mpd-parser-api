/**
 * Dummy CEA parser.
 * @implements {shaka.extern.ICeaParser}
 */
class DummyCeaParser {
  /**
   * @override
   */
  init(initSegment) {
  }

  /**
   * @override
   */
  parse(mediaSegment) {
    return /* captionPackets= */ [];
  }
};

module.exports = DummyCeaParser;
