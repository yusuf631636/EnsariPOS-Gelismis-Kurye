/* Restoran ekranina anlik bildirim (kim hangi paketi aldi, kim teslim etti) icin
   basit yayin (broadcast) katmani - node:http'in kendi upgrade mekanizmasi + 'ws' paketi. */
const { WebSocketServer } = require('ws');

let wss = null;

function attach(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
}
function broadcastEvent(event) {
  if (!wss) return;
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

module.exports = { attach, broadcastEvent };
