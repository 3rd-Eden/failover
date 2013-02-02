# Failover

A generalized failover solution for TCP based servers.

#### Features:

- Detects when a connection has been closed.
- Automatically upgrades the old TCP instance to a new connection.

### Failover.on('failover', from, to, tcp)

A failover has occured successfully and the TCP connection has been upgraded
from it's old server/port combination to a new server/port combination.

### Failover.on('death', server, tcp)

The server has died, there are no more servers left in the failover pool.
