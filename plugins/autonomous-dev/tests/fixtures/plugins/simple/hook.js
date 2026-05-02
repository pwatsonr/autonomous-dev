'use strict';

// Echo hook fixture for the `simple` plugin (SPEC-019-1-02).
module.exports = function echo(context) {
  return { ok: true, fixture: 'simple', received: context };
};
