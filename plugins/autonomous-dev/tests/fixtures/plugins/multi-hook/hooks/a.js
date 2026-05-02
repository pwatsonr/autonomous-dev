'use strict';

module.exports = function (context) {
  return { ok: true, fixture: 'multi-hook', marker: 'a', received: context };
};
