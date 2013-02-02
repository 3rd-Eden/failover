'use strict';

var EventEmitter = require('events').EventEmitter
  , net = require('net');

function Failover(servers, options) {
  servers = servers || [];
  options = options || {};

  this.raise = false;             // Raise an error if no more servers are found.
  this.retries = 0;               // Times to retry the request.
  this.attempts = 5;              // How many attempts before we mark the server as dead.
  this.reuse = true;              // When a server dies add it as failover server once.
  this.timeout = 1000;            // No activity, kill the connection.
  this.minDelay = 1000;           // The minimum delay of the strategy
  this.maxDelay = Infinity;       // The maximum delay of the strategy
  this.strategy = 'exponential';  // What kind of backoff should we use.

  //
  // The actual service that we need test and provide failover support to.
  //
  this.servers = servers;

  Object.keys(options).reduce(function config(self, key) {
    self[key] = options[key];
    return self;
  }, this);

  this.options = options || {};
  this.connections = {};          // Saves all connections per server/port combo
  this.destroyed = false;         // The failover instance is destroyed
  this.history = {};              // Historic upgrades as not every connection dies

  this.metrics = {
      'attempts':    0            // Total reconnect attempts made.
    , 'successfull': 0            // Successfull reconnects.
    , 'failures':    0            // Failed reconection attempts.
    , 'downtime':    0            // Total dowm time of this server.
  };
}

Failover.prototype.__proto__ = EventEmitter.prototype;

/**
 * Reclaim a fail over server.
 *
 * @param {String} server
 * @returns {Boolean} success
 * @api public
 */
Failover.prototype.reclaim = function reclaim(server) {
  var indexOf = this.servers.indexOf(server);

  if (!~indexOf) return false;
  this.servers.splice(indexOf, 1);

  return true;
};

/**
 * Adds a new fail over server.
 *
 * @param {String} server
 * @returns {Boolean} success
 * @api public
 */
Failover.prototype.push = function push(server) {
  var indexOf = this.servers.indexOf(server);

  if (!~indexOf) return false;
  this.server.push(server);

  return true;
};

/**
 * Get's and removes all event listeners from an EventListener
 *
 * @param {EventListener} connection
 * @returns {Object}
 * @api private
 */
Failover.prototype.get = function get(connection) {
  var listeners = Object.create(null);

  [
      'data'
    , 'end'
    , 'timeout'
    , 'drain'
    , 'error'
    , 'close'
  ].forEach(function events(event) {
    // Remove the old listeners, so they are not triggered when we reconnect
    listeners[event] = connection.listeners(event);
    connection.removeAllListeners(event);
  });

  return listeners;
};

/**
 * Set's all extracted listeners back on the connection.
 *
 * @param {EventEmitter} connection
 * @param {Object} listeners
 * @api private
 */
Failover.prototype.set = function set(connection, listeners) {
  Object.keys(listeners).forEach(function each(event) {
    listeners[event].forEach(function listen(callback) {
      connection.on(event, callback);
    });
  });
};

/**
 * Add another connection to the failover instance.
 *
 * @param {net.Socket} connection
 * @returns {net.Socket} the same connection, it's merely passing through
 * @api private
 */
Failover.prototype.connect = function connect(connection) {
  var address = connection.address()
    , self = this;

  // Create a uniform interface for the address details.
  address.host = address.address;
  address.string = address.host +':'+ address.port;

  connection.once('close', function close(err) {
    if (
        !err                              // did not die due to an error
      || self.destroyed                   // this instance was destroyed
      || !self.connection[address.string] // unknown connection, bailout
    ) return;

    // We don't have any servers self to fail over to, emit death
    if (!self.servers.length) {

    }

    var failover = self.servers.pop();

    self.emit('failover', address, failover, connection);
    self.upgrade(connection, address, failover);
  });

  // It could be that we received an connection that is from a connection pool,
  // so we should add it to our internal connection queue so we can fail over
  // every single connection that is in it.
  if (!this.connections[address.string]) {
    this.connections[address.string] = [connection];
  } else if (!~this.connections[address.string].indexOf(connection)) {
    this.connections[address.string].push(connection);
  }

  return connection;
};

/**
 * Have the connection upgrade to a new fallover server.
 *
 * @api private
 */
Failover.prototype.upgrade = function upgrade(connection, from, to) {
  var connections = this.connections[from.string].splice(0)
    , listeners = this.get(connection)
    , self = this;

  /**
   * Cross your fingers and hope that this server is still working and that the
   * connection upgrade happens without any failures.
   *
   * @api private
   */
  function either(failed) {
    // Remove our attached EventListeners
    connection.removeEventListener('connect', either);
    connection.removeEventListener('error', either);

    // Re-attach the EventListeners that we erased from the connection
    self.set(connection, listeners);

    // Well fuck, the connection failed
    // @TODO probalby mark the rest of the servers as failed as well.
    if (failed) return self.emit('death', to, connection);
    if (!connections) return;

    // If we didn't have a failure it's save enough to upgrade the rest of the
    // connections to this.

  }

  connection.once('connect', either);
  connection.once('error', either);

  // Connect with the new server details
  connection.connect(to.port, to.host);
  return connection;
};

/**
 * Attempt to reconnect to the given connection using an exponential backoff
 * algorithm.
 *
 * @param {Function} callback callback that needs to be executed after x
 * @param {Object} opts options for configuring the timeout
 * @api private
 */
Failover.prototype.exponential = function exponential(callback, opts) {
  opts.maxDelay = opts.maxDelay || this.maxDelay;
  opts.minDelay = opts.minDelay || this.minDelay;
  opts.retries = opts.retries || this.retries;
  opts.attempt = opts.attempt || 0;
  opts.factor = opts.factor || 2;

  // Calculate the timeout, but make it randomly so we don't retry connections
  // at the same interval and defeat the purpose. This exponential backoff is
  // based on the work of:
  //
  // http://dthain.blogspot.nl/2009/02/exponential-backoff-in-distributed.html
  var timeout = Math.min(
      Math.round(
        (Math.random() * 1) * opts.minDelay * Math.pow(opts.factor, opts.attempt)
      )
    , opts.maxDelay
  );

  setTimeout(callback, timeout);
};

/**
 * Attempt to reconnect to the given connection using an fixed interval.
 */
Failover.prototype.fixed = function fixed(callback, opts) {
  opts.timeout = opts.timeout || this.minDelay;

  setTimeout(callback, opts.timeout);
};

/**
 * Attempt to reconnect to the given connection using an fibonacci backoff
 * algorithm.
 */
Failover.prototype.fibonacci = function fibonacci(callback, opts) {
  setTimeout(callback, 1000);
};

/**
 * Kills the failover shizzle, freeing all listeners.
 *
 * @api public
 */
Failover.prototype.end = function end() {
  this.destroyed = true;
  this.connection = Object.create(null);
};
