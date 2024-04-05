class AbortableOperation {
  constructor(promise, onAbort) {
    this.promise = promise;
    this.onAbort_ = onAbort;
    this.aborted_ = false;
  }

  static failed(error) {
    return new AbortableOperation(Promise.reject(error), () => Promise.resolve());
  }

  static aborted() {
    const p = Promise.reject(AbortableOperation.abortError());
    p.catch(() => {}); // Silence uncaught rejection errors
    return new AbortableOperation(p, () => Promise.resolve());
  }

  static abortError() {
    return new Error('CRITICAL', 'PLAYER', 'OPERATION_ABORTED');
  }

  static completed(value) {
    return new AbortableOperation(Promise.resolve(value), () => Promise.resolve());
  }

  static notAbortable(promise) {
    return new AbortableOperation(promise, () => promise.catch(() => {}));
  }

  abort() {
    this.aborted_ = true;
    return this.onAbort_();
  }

  static all(operations) {
    return new AbortableOperation(
      Promise.all(operations.map(op => op.promise)),
      () => Promise.all(operations.map(op => op.abort()))
    );
  }

  finally(onFinal) {
    this.promise.then(() => onFinal(true), () => onFinal(false));
    return this;
  }

  chain(onSuccess, onError) {
    const newPromise = new Promise((resolve, reject) => {
      this.promise.then(value => {
        try {
          if (this.aborted_) {
            throw AbortableOperation.abortError();
          }
          const result = onSuccess ? onSuccess(value) : value;
          if (result && typeof result.then === 'function') {
            result.then(resolve, reject);
          } else {
            resolve(result);
          }
        } catch (e) {
          reject(e);
        }
      }, error => {
        if (onError) {
          try {
            const result = onError(error);
            if (result && typeof result.then === 'function') {
              result.then(resolve, reject);
            } else {
              resolve(result);
            }
          } catch (e) {
            reject(e);
          }
        } else {
          reject(error);
        }
      });
    });

    let aborted = false;
    const onAbort = () => {
      if (!aborted) {
        aborted = true;
        return this.abort().then(() => {}, () => {});
      }
      return Promise.resolve();
    };

    return new AbortableOperation(newPromise, onAbort);
  }
}

module.exports = AbortableOperation;
