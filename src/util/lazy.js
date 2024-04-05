const assert = require('assert');

class Lazy {
/** @param {function():T} gen */
constructor(gen) {
    /** @private {function():T} */
    this.gen_ = gen;

    /** @private {T|undefined} */
    this.value_ = undefined;
  }

  /** @return {T} */
  value() {
    if (this.value_ == undefined) {
      // Compiler complains about unknown fields without this cast.
      this.value_ = /** @type {*} */ (this.gen_());
      assert(
          this.value_ != undefined, 'Unable to create lazy value');
    }
    return this.value_;
  }

  /** Resets the value of the lazy function, so it has to be remade. */
  reset() {
    this.value_ = undefined;
  }
};

module.exports = Lazy;