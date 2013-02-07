'use strict';

var Failover = require('../')
  , chai = require('chai')
  , net = require('net');

var expect = chai.expect;
chai.Assertion.includeStack = true;

describe('new Failover()', function () {
  it('constructs without issues', function () {
    new Failover();
  });

  it('applies the options', function () {
    var fail = new Failover([], { retries: 99 });

    expect(fail.retries).to.equal(99);
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

    expect(fail).to.be.instanceOf(require('events').EventEmitter);
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
    var EventEmitter = require('events').EventEmitter
      , removed = [
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
    var EventEmitter = require('events').EventEmitter
      , removed = [
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
});
