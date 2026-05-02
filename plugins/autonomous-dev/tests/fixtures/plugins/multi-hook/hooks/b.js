'use strict';

module.exports = function (context) {
  return { ok: true, fixture: 'multi-hook', marker: 'b', received: context };
};
