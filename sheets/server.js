const EventEmitter = require('events');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

[
  'uncaughtException',
  'unhandledRejection'
].forEach((event) =>
  process.on(event, (err) => {
    console.error(`something bad happened! event: ${event}, msg: ${err.stack || err}`);
  }));

const connections = Object.create(null);

const lockedElements = new Map();

const opcodes = {
  TEXT: 1,
  BINARY: 2,
  CLOSE: 8,
  PING: 9,
  PONG: 10
};

const MAGIC_STRING_KEY = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function hashWebSocketKey(key) {
  const sha1 = crypto.createHash('sha1');

  sha1.update(key + MAGIC_STRING_KEY, 'ascii');

  return sha1.digest('base64');
};

const index = fs.readFileSync('./index.html', 'utf8');

class WSConnection extends EventEmitter {
  constructor(req, socket, upgradeHead) {
    super();
    const self = this;
    const key = hashWebSocketKey(req.headers['sec-websocket-key']);

    socket.write('HTTP/1.1 101 Web Socket Protocol Handshake\r\n' + 'Upgrade: WebSocket\r\n' + 'Connection: Upgrade\r\n' + 'sec-websocket-accept: ' + key + '\r\n\r\n');

    socket.on('data', function(buf) {
      self.buffer = Buffer.concat([self.buffer, buf]);
      while (self._processBuffer()) { }
    });
    this.id = Math.round(Math.random() * 30) + Date.now();
    this.connections = connections;
    this.locketList = lockedElements;
    this.socket = socket;
    this.buffer = new Buffer(0);
    this.closed = false;
    this.connections[this.id] = this;
  }

  send(obj) {
    console.log(obj);
    let opcode;
    let payload;

    if (Buffer.isBuffer(obj)) {
      opcode = opcodes.BINARY;
      payload = obj;
    } else if (typeof obj == 'string') {
      opcode = opcodes.TEXT;
      // let lock = this.locketList;
      // let dto = JSON.parse(obj);
      // if(lock.has(dto?.userId)){
      //   dto.unLock = lock.get(dto.userId);
      //   lock.set(dto.userId, dto?.cell);
      // } else{
      //   lock.set(dto.userId, dto.cell);
      // }
      // dto = JSON.stringify(dto);
      payload = new Buffer(obj, 'utf8');
    } else {
      throw new Error('Cannot send object. Must be string or Buffer');
    }
    this._doSend(opcode, payload);
  }

  close(code, reason) {
    const opcode = opcodes.CLOSE;
    let buffer;

    if (code) {
      buffer = new Buffer(Buffer.byteLength(reason) + 2);
      buffer.writeUInt16BE(code, 0);
      buffer.write(reason, 2);
    } else {
      buffer = new Buffer(0);
    }
    this._doSend(opcode, buffer);
    this.closed = true;
  }

  _unmask(maskBytes, data) {
    const payload = new Buffer(data.length);

    for (let i = 0; i < data.length; i++) {
      payload[i] = maskBytes[i % 4] ^ data[i];
    }

    return payload;
  }

  _processBuffer() {
    const buf = this.buffer;

    if (buf.length < 2) {
      return;
    }

    let idx = 2;
    const b1 = buf.readUInt8(0);
    // let fin = b1 & 0x80;
    const opcode = b1 & 0x0f;

    const b2 = buf.readUInt8(1);
    // let mask = b2 & 0x80;
    let length = b2 & 0x7f;

    if (length > 125) {
      if (buf.length < 8) {
        return;
      }

      if (length == 126) {
        length = buf.readUInt16BE(2);
        idx += 2;
      } else if (length == 127) {
        const highBits = buf.readUInt32BE(2);

        if (highBits != 0) {
          this.close(1009, '');
        }
        length = buf.readUInt32BE(6);
        idx += 8;
      }
    }

    if (buf.length < idx + 4 + length) {
      return;
    }

    const maskBytes = buf.slice(idx, idx + 4);

    idx += 4;
    let payload = buf.slice(idx, idx + length);

    payload = this._unmask(maskBytes, payload);
    this._handleFrame(opcode, payload);

    this.buffer = buf.slice(idx + length);

    return true;
  }

  _handleFrame(opcode, buffer) {
    let payload;

    switch (opcode) {
    case opcodes.TEXT:
      payload = buffer.toString('utf8');
      this.emit('data', opcode, payload);
      break;
    case opcodes.BINARY:
      payload = buffer;
      this.emit('data', opcode, payload);
      break;
    case opcodes.PING:
      this._doSend(opcodes.PONG, buffer);
      break;
    case opcodes.PONG:
      break;
    case opcodes.CLOSE:
      let code; let reason;

      if (buffer.length >= 2) {
        code = buffer.readUInt16BE(0);
        reason = buffer.toString('utf8', 2);
      }
      this.close(code, reason);
      this.emit('close', code, reason);
      break;
    default:
      this.close(1002, 'unknown opcode');
    }
  }

  _encodeMessage(opcode, payload) {
    let buf;

    const b1 = 0x80 | opcode;

    let b2 = 0;

    const length = payload.length;

    if (length < 126) {
      buf = new Buffer(payload.length + 2 + 0);
      b2 |= length;
      buf.writeUInt8(b1, 0);
      buf.writeUInt8(b2, 1);
      payload.copy(buf, 2);
    } else if (length < (1 << 16)) {
      buf = new Buffer(payload.length + 2 + 2);
      b2 |= 126;
      buf.writeUInt8(b1, 0);
      buf.writeUInt8(b2, 1);
      buf.writeUInt16BE(length, 2);
      payload.copy(buf, 4);
    } else {
      buf = new Buffer(payload.length + 2 + 8);
      b2 |= 127;
      buf.writeUInt8(b1, 0);
      buf.writeUInt8(b2, 1);
      buf.writeUInt32BE(0, 2);
      buf.writeUInt32BE(length, 6);
      payload.copy(buf, 10);
    }

    return buf;
  }

  _doSend(opcode, payload) {
    for (const c of Object.values(this.connections)) {
      c.socket.write(this._encodeMessage(opcode, payload));
    }
  }
}

exports.listen = function(port, host, connectionHandler) {
  const srv = http.createServer(function(req, res) {
    res.writeHead(200);
    res.end(index);
  });

  srv.on('upgrade', function(req, socket, upgradeHead) {
    const ws = new WSConnection(req, socket, upgradeHead);

    connectionHandler(ws);
  });

  srv.listen(port, host);
};
