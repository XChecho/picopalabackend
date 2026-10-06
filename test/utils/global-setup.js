/* Probes the optional Redis so Redis-dependent suites can be skipped when it is down. */
const net = require('net');

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

module.exports = async () => {
  process.env.E2E_REDIS_UP = (await probe(63990)) ? '1' : '0';
};
