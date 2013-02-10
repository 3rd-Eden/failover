'use strict';

var portnumbers = 1024;

/**
 * Automatic increasing test numbers.
 *
 * Example:
 *   var port = portnumbers
 *     , another = portnumbers;
 *
 *   console.log(port, portnumber); // 1025, 1026
 *
 * @api public
 */
Object.defineProperty(global, 'portnumber', {
  get: function get() {
    return portnumbers++;
  }
});
