class TransmuxerEngine {
  /**
 * @typedef {{
 *   plugin: shaka.extern.TransmuxerPlugin,
  *   priority: number
  * }}
  * @property {shaka.extern.TransmuxerPlugin} plugin
  *   The associated plugin.
  * @property {number} priority
  *   The plugin's priority.
  */
  static PluginObject;


  /**
   * @private {!Object.<string, !static PluginObject>}
   */
  static transmuxerMap_ = {};


  /**
   * Priority level for transmuxer plugins.
   * If multiple plugins are provided for the same mime type, only the
   * highest-priority one is used.
   *
   * @enum {number}
   * @export
   */
  static PluginPriority = {
    'FALLBACK': 1,
    'PREFERRED_SECONDARY': 2,
    'PREFERRED': 3,
    'APPLICATION': 4,
  };
  // TODO: revisit this when the compiler supports partially-exported classes.
  /**
   * @override
   * @export
   */
  destroy() { }

  /**
   * @param {string} mimeType
   * @param {!shaka.extern.TransmuxerPlugin} plugin
   * @param {number} priority
   * @export
   */
  static registerTransmuxer(mimeType, plugin, priority) {
    const normalizedMimetype = this.normalizeMimeType_(mimeType);
    const key = normalizedMimetype + '-' + priority;
    this.transmuxerMap_[key] = {
      priority: priority,
      plugin: plugin,
    };
  }

  /**
   * @param {string} mimeType
   * @param {number} priority
   * @export
   */
  static unregisterTransmuxer(mimeType, priority) {
    const normalizedMimetype = this.normalizeMimeType_(mimeType);
    const key = normalizedMimetype + '-' + priority;
    delete this.transmuxerMap_[key];
  }

  /**
   * @param {string} mimeType
   * @param {string=} contentType
   * @return {?shaka.extern.TransmuxerPlugin}
   * @export
   */
  static findTransmuxer(mimeType, contentType) {
    const normalizedMimetype = this.normalizeMimeType_(mimeType);
    const priorities = [
      this.PluginPriority.APPLICATION,
      this.PluginPriority.PREFERRED,
      this.PluginPriority.PREFERRED_SECONDARY,
      this.PluginPriority.FALLBACK,
    ];
    for (const priority of priorities) {
      const key = normalizedMimetype + '-' + priority;
      const object = this.transmuxerMap_[key];
      if (object) {
        const transmuxer = object.plugin();
        const isSupported = transmuxer.isSupported(mimeType, contentType);
        transmuxer.destroy();
        if (isSupported) {
          return object.plugin;
        }
      }
    }
    return null;
  }

  /**
   * @param {string} mimeType
   * @return {string}
   * @private
   */
  static normalizeMimeType_(mimeType) {
    return mimeType.toLowerCase().split(';')[0];
  }

  /**
   * Check if the mime type and the content type is supported.
   * @param {string} mimeType
   * @param {string=} contentType
   * @return {boolean}
   */
  static isSupported(mimeType, contentType) {
    const transmuxerPlugin = this.findTransmuxer(mimeType);
    if (!transmuxerPlugin) {
      return false;
    }
    return true;
  }

  /**
   * For any stream, convert its codecs to MP4 codecs.
   * @param {string} contentType
   * @param {string} mimeType
   * @return {string}
   */
  static convertCodecs(contentType, mimeType) {
    const transmuxerPlugin = this.findTransmuxer(mimeType);
    if (!transmuxerPlugin) {
      return mimeType;
    }
    const transmuxer = transmuxerPlugin();
    const codecs = transmuxer.convertCodecs(contentType, mimeType);
    transmuxer.destroy();
    return codecs;
  }
};

module.exports = TransmuxerEngine;