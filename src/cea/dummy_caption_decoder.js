/** @implements {shaka.extern.ICaptionDecoder} */
class DummyCaptionDecoder {
  /** @override */
  extract(userDataSeiMessage, pts) {}

  /** @override */
  decode() {
    return [];
  }

  /** @override */
  clear() {}

  /** @override */
  getStreams() {
    return [];
  }
};

module.exports = DummyCaptionDecoder;
