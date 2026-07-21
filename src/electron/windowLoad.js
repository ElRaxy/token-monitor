'use strict';

function observeWindowLoad(loadPromise, handlers = {}) {
  return Promise.resolve(loadPromise).then(
    () => {
      const result = { ok: true };
      handlers.onSettled?.(result);
      return result;
    },
    (error) => {
      const result = { ok: false, error };
      // Roll replacement windows back before the normal load-error handler
      // tries to reveal the failed candidate.
      handlers.onSettled?.(result);
      handlers.onRejected?.(error);
      return result;
    },
  );
}

module.exports = { observeWindowLoad };
