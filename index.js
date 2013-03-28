'use strict';

var EventEmitter = require('events').EventEmitter
  , parse = require('connection-parse')
  , stack = require('callsite')
  , net = require('net');

function Failover(servers, options) {
  servers = servers || [];
  options = options || {};

  this.attempts = 5;              // How many attempts before we mark the server as dead.
  this.timeout = 1000;            // Time out between the attempts
  this.reuse = true;              // When a server dies add it as failover server once.
  this.minDelay = 1000;           // The minimum delay of the strategy
  this.maxDelay = Infinity;       // The maximum delay of the strategy
  this.strategy = 'exponential';  // What kind of backoff should we use.
  this.upgrade = true;            // Should we upgrade the conneection

  Object.keys(options).reduce(function config(self, key) {
    if (key in self) self[key] = options[key];
  }, this);

  //
  // The actual service that we need test and provide failover support to.
  //
  this.servers = parse(servers).servers;

  this.options = options;
  this.connections = {};          // Saves all connections per server/port combo
  this.destroyed = false;         // The failover instance is destroyed
  this.history = {};              // Historic upgrades as not every connection dies

  this.metrics = {
      'attempts':    0            // Total reconnect attempts made.
    , 'successfull': 0            // Successfull reconnects.
    , 'failures':    0            // Failed reconnection attempts.
    , 'downtime':    0            // Total dowm time of this server.
  };

  // Start listening for the `failover` events so we can start upgrading the
  // connection.
  if (this.upgrade) this.on('failover', this.upgrader.bind(this));
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

  if (~indexOf) return false;
  this.servers.push(server);

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
  ].forEach(function removal(event) {
    var events = connection.listeners(event);
    if (!events.length) return;

    // Remove the old listeners, so they are not triggered when we reconnect
    listeners[event] = events;
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
  var self = this
    , address;

  // @TODO we might also want to be listening to close/error for quick failing
  // connections.
  if (!connection.remoteAddress || !connection.remotePort) {
    return connection.once('connect', function connected() {
      self.connect(connection);
    });
  }

  // Create a uniform interface for the address details.
  address = parse(connection.remoteAddress +':'+ connection.remotePort).servers[0];

  /**
   * Trigger function that listens to the different connection state changes and
   * determins if we need to failover to a different server.
   *
   * @param {Error} err
   * @api private
   */
  function trigger(err) {
    // Remove the event listeners, this also prevents this function from being
    // called twice if an error occured
    connection.removeListener('error', trigger);
    connection.removeListener('close', trigger);

    // Determin if this connection was closed intended or unintendded
    if (
      !connection.closeByNode              // The _flag is set to one 1 if the server
                                           // closed the connection
      && !err                              // Did not die due to an error
      || self.destroyed                    // This instance was destroyed
      || !self.connections[address.string] // Unknown connection, bailout
    ) return;

    // We don't have any servers self to fail over to, emit death
    if (!self.servers.length) {
      return self.emit('death', address, connection);
    }

    var failover = self.servers.pop();

    self.history[address.string] = failover;
    self.emit('failover', address, failover, connection);
  }

  // Assign the event listeners
  connection.once('close', trigger);
  connection.once('error', trigger);

  // Override the end/destroy properties so we can figure out who killed the
  // connection, should be done BEFORE we set the `parsedAddress`
  this.override(connection);

  // Add extra properties to the connection.
  connection.parsedAddress = address;

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
 * Fucking horrible hacky way of figuring out where the connection has been
 * closed. We don't receive any information from node on where we got our `end`
 * and `destroy` calls from. The only way to trace it down to node is to track
 * it to the `onread` function using a stack trace... Which is horrible..
 *
 * @param {net.Connection} connection
 * @api private
 */
Failover.prototype.override = function override(connection) {
  // This connection has been called for the second time..
  if ('parsedAddress' in connection) return;

  // This connection is not yet closed by Node
  connection.closeByNode = false;

  ['end', 'destroy'].forEach(function wrapper(method) {
    var old = connection[method];

    connection[method] = function wrapping() {
      stack().slice(1, 2).forEach(function stacktrace(site) {
        // console.log(site.getFileName(), site.getFunctionName());
        if ('net.js' === site.getFileName() && 'onread' === site.getFunctionName()) {
          connection.closeByNode = true;
        }
      });

      // Re-call the original method with all the arguments
      old.apply(this, arguments);
    };
  });
};

/**
 * Have the connection upgrade to a new fallover server.
 *
 * @param {Object} from
 * @param {Object} to
 * @param {net.Connection} connection
 * @api private
 */
Failover.prototype.upgrader = function upgrade(from, to, connection) {
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
    connection.removeListener('connect', either);
    connection.removeListener('error', either);

    // Re-attach the EventListeners that we erased from the connection
    self.set(connection, listeners);

    // Well fuck, the connection failed
    // @TODO probalby mark the rest of the servers as failed as well.
    if (failed) return self.emit('death', to, connection);

    // Successful upgrade the connection, emit this and start listining for
    // connection failures again.
    self.emit('upgraded', from, to, connection);
    self.connect(connection);
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
 * Options:
 *
 * - maxDelay: Maximum delay of the backoff
 * - minDelay: Minimum delay of the backoff
 * - reties: The amount of allowed retries
 * - factor: Exponential backoff factor
 * - attempt: Current attempt
 *
 * @param {Function} callback callback that needs to be executed after x
 * @param {Object} opts options for configuring the timeout
 * @api private
 */
Failover.prototype.exponential = function exponential(callback, opts) {
  opts = opts || {};

  opts.maxDelay = opts.maxDelay || this.maxDelay;
  opts.minDelay = opts.minDelay || this.minDelay;
  opts.retries = opts.retries || this.retries;
  opts.attempt = (opts.attempt || 0) + 1;
  opts.factor = opts.factor || 2;

  // Bailout if we are about to make to much attempts. Please note that we use
  // `>` because we already incremented the value above.
  if (opts.attempt > opts.retries || opts.backoff) {
    return callback(new Error('Unable to retry'), opts);
  }

  // Calculate the timeout, but make it randomly so we don't retry connections
  // at the same interval and defeat the purpose. This exponential backoff is
  // based on the work of:
  //
  // http://dthain.blogspot.nl/2009/02/exponential-backoff-in-distributed.html
  opts.timeout = Math.min(
      Math.round(
        (Math.random() * 1) * opts.minDelay * Math.pow(opts.factor, opts.attempt)
      )
    , opts.maxDelay
  );

  setTimeout(function timeout() {
    callback(undefined, opts);
  }, opts.timeout);
};

/**
 * Attempt to reconnect to the given connection using an fixed interval.
 */
Failover.prototype.fixed = function fixed(callback, opts) {
  opts = opts || {};

  opts.timeout = opts.timeout || this.minDelay;

  setTimeout(function timeout() {
    callback(undefined, opts);
  }, opts.timeout);
};

/**
 * Attempt to reconnect to the given connection using an fibonacci backoff
 * algorithm.
 */
Failover.prototype.fibonacci = function fibonacci(callback, opts) {
  opts = opts || {};

  setTimeout(function timeout() {
    callback(undefined, opts);
  }, 1000);
};

/**
 * Kills the failover shizzle, freeing all listeners.
 *
 * @param {Boolean} nuke also kill all the connections that we are attached on
 * @api public
 */
Failover.prototype.end = function end(nuke) {
  this.destroyed = true;

  // We are allready flagged as closed, see if we need to nuke existing
  // connections.
  if (nuke) Object.keys(this.connections).forEach(function connection(string) {
    this.connections[string].forEach(function end(connection) {
      connection.end();
    });
  }.bind(this));

  this.connections = Object.create(null);
};

Failover.prototype.destroy = Failover.prototype.end;

/**
 * Expose the module.
 */
module.exports = Failover;
