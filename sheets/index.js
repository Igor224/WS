const websocket = require('./server');

websocket.listen(8000, 'localhost', function(conn) {
  console.log('connection opened');
  conn.on('data', function(opcode, data) {
    conn.send(data);
  });

  conn.on('close', function(code, reason) {
    console.log('connection closed: ', code, reason);
  });
});
