/*global portnumber */
'use strict';

var EventEmitter = require('events').EventEmitter
  , Failover = require('../')
  , chai = require('chai')
  , net = require('net');

var expect = chai.expect;
chai.Assertion.includeStack = true;

describe('new Failover()', function () {
  it('constructs without issues', function () {
    new Failover();
  });

  it('applies the options', function () {
    var fail = new Failover([], { attempts: 99 });

    expect(fail.attempts).to.equal(99);
  });

  it('does not add properties that does not exist', function () {
    var fail = new Failover([], { 'what the fuck yo': 12 });

    expect(fail).to.not.have.property('what the fuck yo');
  });

  it('does not override private properties', function () {
    var fail = new Failover([], { destroyed: true });

    expect(fail.destroyed).to.equal(false);
  });

  it('inherits from EventEmitter', function () {
    var fail = new Failover();

    expect(fail).to.be.instanceOf(EventEmitter);
  });
});

describe('Failover', function () {
  describe('#push', function () {
    it('adds a new failover server', function () {
      var fail = new Failover();

      expect(fail.servers).to.have.lengthOf(0);
      expect(fail.push(1)).to.equal(true);
      expect(fail.servers).to.have.lengthOf(1);
      expect(fail.servers.pop()).to.equal(1);
    });

    it('does not add a server if it already exists', function () {
      var fail = new Failover([1]);

      expect(fail.servers).to.have.lengthOf(1);
      expect(fail.push(1)).to.equal(false);
      expect(fail.servers).to.have.lengthOf(1);
    });
  });

  describe('#reclaim', function () {
    it('removes the failover server', function () {
      var fail = new Failover([1]);

      expect(fail.servers).to.have.lengthOf(1);
      expect(fail.reclaim(1)).to.equal(true);
      expect(fail.servers).to.have.lengthOf(0);
    });

    it('Does not remove unknown servers', function () {
      var fail = new Failover([1]);

      expect(fail.servers).to.have.lengthOf(1);
      expect(fail.reclaim(3)).to.equal(false);
      expect(fail.servers).to.have.lengthOf(1);
    });
  });

  describe('#get', function () {
    var removed = [
        'data'
      , 'end'
      , 'timeout'
      , 'drain'
      , 'error'
      , 'close'
    ];

    it('removes nothing if there are no events added,', function () {
      var fail = new Failover()
        , conn = new EventEmitter()
        , events = fail.get(conn);

      expect(Object.keys(events)).to.have.lengthOf(0);
    });

    it('removes the data,end,timeout,drain,error,close events', function () {
      var fail = new Failover()
        , conn = new EventEmitter()
        , calls = 0;

      function incr() {
        calls++;
      }

      removed.forEach(function (event) {
        conn.on(event, incr);
      });

      var events = fail.get(conn);

      // test if the events are removed
      removed.forEach(function (event) {
        // Don't emit errors, it throws ;(
        if (event !== 'error') conn.emit(event);
      });

      expect(calls).to.equal(0);

      Object.keys(events).forEach(function (event) {
        events[event].forEach(function (callback) {
          expect(callback).to.equal(incr);
        });
      });
    });
  });

  describe('#set', function () {
    var removed = [
        'data'
      , 'end'
      , 'timeout'
      , 'drain'
      , 'error'
      , 'close'
    ];

    it('adds the removed data,end,timeout,drain,error,close events', function () {
      var fail = new Failover()
        , conn = new EventEmitter()
        , calls = 0;

      function incr() {
        calls++;
      }

      removed.forEach(function (event) {
        conn.on(event, incr);
      });

      fail.set(conn, fail.get(conn));

      // test if the events are removed
      removed.forEach(conn.emit.bind(conn));
      expect(calls).to.equal(6);
    });

    it('correctly adds `once` listeners', function () {
      var fail = new Failover()
        , conn = new EventEmitter()
        , calls = 0;

      function incr() {
        calls++;
      }

      conn.once('data', incr);
      fail.set(conn, fail.get(conn));

      conn.emit('data');
      conn.emit('data');
      conn.emit('data');

      expect(calls).to.equal(1);
    });
  });

  describe('#connect', function () {
    var connections = []
      , server
      , port;

    beforeEach(function after(done) {
      port = portnumber;
      server = net.createServer(function connection(c) {
        connections.push(c);
      });

      server.listen(port, done);
    });

    afterEach(function after(done) {
      server.close();
      connections.forEach(function forEach(c) {
        c.end();
      });

      connections.length = 0;
      done();
    });

    it('returns the passed connection', function () {
      var fail = new Failover('localhost:3333', { upgrade: false })
        , connection = net.connect(port);

      expect(fail.connect(connection)).to.equal(connection);
    });

    it('emits `death` when there are no servers to fail over to', function (done) {
      var fail = new Failover([], { upgrade: false })
        , connection = net.connect(port);

      fail.once('death', function death(address, conn) {
        expect(conn).to.equal(connection);
        expect(address.port).to.equal(port);
        expect(address.host).to.equal('127.0.0.1');
        expect(address.string).to.equal('127.0.0.1:'+ address.port);

        done();
      });

      fail.connect(connection);

      connection.once('connect', function () {
        connection.destroy(new Error('DIEEE MOTHERFUCKERRR'));
      });
    });

    it('emits `failover` when the connection receives an error', function (done) {
      var fail = new Failover('127.0.0.1:2232', { upgrade: false })
        , connection = net.connect(port);

      fail.once('failover', function failover(from, to, conn) {
        expect(conn).to.equal(connection);

        expect(from.port).to.equal(port);
        expect(from.host).to.equal('127.0.0.1');
        expect(from.string).to.equal('127.0.0.1:'+ from.port);

        expect(to.port).to.equal(2232);
        expect(to.host).to.equal('127.0.0.1');
        expect(to.string).to.equal('127.0.0.1:'+ 2232);

        done();
      });

      fail.connect(connection);

      connection.once('connect', function () {
        connection.emit('error', new Error('DIEEE MOTHERFUCKERRR'));
      });
    });

    it('emits `failover` when the server closes the connection', function (done) {
      var fail = new Failover('127.0.0.1:2232', { upgrade: false })
        , connection = net.connect(port);

      fail.once('failover', function failover(from, to, conn) {
        expect(conn).to.equal(connection);

        expect(from.port).to.equal(port);
        expect(from.host).to.equal('127.0.0.1');
        expect(from.string).to.equal('127.0.0.1:'+ from.port);

        expect(to.port).to.equal(2232);
        expect(to.host).to.equal('127.0.0.1');
        expect(to.string).to.equal('127.0.0.1:'+ 2232);

        done();
      });

      fail.connect(connection);

      connection.once('connect', function connect() {
        setTimeout(function setTimeout() {
          connections.pop().end();
        }, 100);
      });
    });

    it('does not emit when we close the connection', function (done) {
      var fail = new Failover('127.0.0.1:2232', { upgrade: false })
        , connection = net.connect(port);

      fail.once('failover', function failover(from, to, conn) {
        done(new Error('LOL WUT, I should not emit failover'));
      });

      fail.connect(connection);

      connection.once('connect', function connect() {
        setTimeout(function setTimeout() {
          connection.end();

          process.nextTick(done);
        }, 100);
      });
    });

    it('does not emit when Failover is destoryed', function (done) {
      var fail = new Failover('127.0.0.1:2232', { upgrade: false })
        , connection = net.connect(port);

      fail.once('failover', function failover(from, to, conn) {
        done(new Error('should not throw errors'));
      });

      fail.connect(connection);
      fail.destroy();

      connection.once('connect', function () {
        connection.emit('error', new Error('DIEEE MOTHERFUCKERRR'));
        done();

        fail.destroy();
      });
    });

    it('maintains history of failed over connections', function (done) {
      var fail = new Failover('127.0.0.1:2232', { upgrade: false })
        , connection = net.connect(port);

      fail.once('failover', function failover(from, to, conn) {

        expect(fail.history[from.string]).to.equal(to);
        done();
      });

      fail.connect(connection);

      connection.once('connect', function () {
        connection.emit('error', new Error('DIEEE MOTHERFUCKERRR'));
      });
    });
  });

  describe('#override', function () {
    it('overrides the connection');

    it('does not override twice');
  });

  describe('#upgrader', function () {
    var servers = {}
      , ports = []
      , length = 0;

    beforeEach(function after(done) {
      for (var i = 0; i < length; i++) {
        var port = portnumber;

        servers[port] = net.createServer(function connection(c) {
          servers[port].CONNECTIONS.push(c);
        });

        servers[port].CONNECTIONS = [];
        servers[port].listen(port, done);

        ports.push(port);
      }
    });

    afterEach(function after(done) {
      Object.keys(servers).forEach(function closing(port) {
        servers[port].close();

        servers[port].CONNECTIONS.forEach(function connections(c) {
          c.end();
        });

        servers[port].CONNECTIONS.length = 0;
      });

      done();
    });
  });
});
