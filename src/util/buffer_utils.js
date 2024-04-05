class BufferUtils {
    /**
   * Compare two buffers for equality.  For buffers of different types, this
   * compares the underlying buffers as binary data.
   *
   * @param {?BufferSource} arr1
   * @param {?BufferSource} arr2
   * @return {boolean}
   * @export
   * @suppress {strictMissingProperties}
   */
    static equal(arr1, arr2) {
        const BufferUtils = shaka.util.BufferUtils;
        if (!arr1 && !arr2) {
            return true;
        }
        if (!arr1 || !arr2) {
            return false;
        }
        if (arr1.byteLength != arr2.byteLength) {
            return false;
        }

        // Quickly check if these are views of the same buffer.  An ArrayBuffer can
        // be passed but doesn't have a byteOffset field, so default to 0.
        if (this.unsafeGetArrayBuffer_(arr1) ==
            this.unsafeGetArrayBuffer_(arr2) &&
            (arr1.byteOffset || 0) == (arr2.byteOffset || 0)) {
            return true;
        }

        const uint8A = this.toUint8(arr1);
        const uint8B = this.toUint8(arr2);
        for (let i = 0; i < arr1.byteLength; i++) {
            if (uint8A[i] != uint8B[i]) {
                return false;
            }
        }
        return true;
    }
    
    /**
     * Gets the underlying ArrayBuffer of the given view.  The caller needs to
     * ensure it uses the "byteOffset" and "byteLength" fields of the view to
     * only use the same "view" of the data.
     *
     * @param {BufferSource} view
     * @return {!ArrayBuffer}
     * @private
     */
    static unsafeGetArrayBuffer_(view) {
        if (view instanceof ArrayBuffer) {
            return view;
        } else {
            return view.buffer;
        }
    }

    /**
     * @param {BufferSource} data
     * @param {number} offset
     * @param {number} length
     * @param {function(new:T, ArrayBuffer, number, number)} Type
     * @return {!T}
     * @template T
     * @private
     */
    static view_(data, offset, length, Type) {
        const buffer = this.unsafeGetArrayBuffer_(data);
        let bytesPerElement = 1;
        if ('BYTES_PER_ELEMENT' in Type) {
            bytesPerElement = Type.BYTES_PER_ELEMENT;
        }
        // Absolute end of the |data| view within |buffer|.
        /** @suppress {strictMissingProperties} */
        const dataEnd = ((data.byteOffset || 0) + data.byteLength) /
            bytesPerElement;
        // Absolute start of the result within |buffer|.
        /** @suppress {strictMissingProperties} */
        const rawStart = ((data.byteOffset || 0) + offset) / bytesPerElement;
        const start = Math.floor(Math.max(0, Math.min(rawStart, dataEnd)));
        // Absolute end of the result within |buffer|.
        const end = Math.floor(Math.min(start + Math.max(length, 0), dataEnd));
        return new Type(buffer, start, end - start);
    }

    /**
     * Creates a new Uint8Array view on the same buffer.  This clamps the values
     * to be within the same view (i.e. you can't use this to move past the end
     * of the view, even if the underlying buffer is larger).  However, you can
     * pass a negative offset to access the data before the view.
     *
     * @param {BufferSource} data
     * @param {number=} offset The offset from the beginning of this data's view
     *   to start the new view at.
     * @param {number=} length The byte length of the new view.
     * @return {!Uint8Array}
     * @export
     */
    static toUint8(data, offset = 0, length = Infinity) {
        return this.view_(data, offset, length, Uint8Array);
    }

    /**
     * Creates a DataView over the given buffer.
     *
     * @see toUint8
     * @param {BufferSource} buffer
     * @param {number=} offset
     * @param {number=} length
     * @return {!DataView}
     * @export
     */
    static toDataView(buffer, offset = 0, length = Infinity) {
        return this.view_(buffer, offset, length, DataView);
    }

};

module.exports = BufferUtils;