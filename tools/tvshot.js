/**
 * Screenshot und Konsolen-Log direkt vom Fernseher holen.
 *
 * Der webOS-Inspector spricht das Chrome DevTools Protocol. Ohne das hier
 * bliebe nur „sieht auf dem Foto komisch aus" – mit ihm lässt sich das Layout
 * auf der echten Hardware prüfen.
 *
 *   ares-inspect --device tv --app de.app.glasstv   # liefert die ws-Adresse
 *   node tools/tvshot.js <ws-url> [ausgabe.png]
 */
'use strict';

var fs = require('fs');

var wsUrl = process.argv[2];
var outFile = process.argv[3] || 'tv-screenshot.png';
if (!wsUrl) {
  console.error('Aufruf: node tools/tvshot.js ws://localhost:PORT/devtools/page/ID [datei.png]');
  process.exit(1);
}

var ws = new WebSocket(wsUrl);
var nextId = 1;
var pending = {};
var logs = [];

function send(method, params) {
  return new Promise(function (resolve, reject) {
    var id = nextId++;
    pending[id] = { resolve: resolve, reject: reject };
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    setTimeout(function () {
      if (pending[id]) { delete pending[id]; reject(new Error(method + ': Zeitüberschreitung')); }
    }, 15000);
  });
}

ws.addEventListener('message', function (event) {
  var msg;
  try { msg = JSON.parse(event.data); } catch (e) { return; }
  if (msg.id && pending[msg.id]) {
    var p = pending[msg.id];
    delete pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
    return;
  }
  // Konsolenausgaben und Laufzeitfehler mitschneiden.
  if (msg.method === 'Console.messageAdded') {
    logs.push('[' + msg.params.message.level + '] ' + msg.params.message.text);
  } else if (msg.method === 'Log.entryAdded') {
    logs.push('[' + msg.params.entry.level + '] ' + msg.params.entry.text);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    var d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception && d.exception.description || d.text));
  }
});

ws.addEventListener('error', function (e) {
  console.error('WebSocket-Fehler:', e.message || e);
  process.exit(1);
});

ws.addEventListener('open', function () {
  Promise.resolve()
    .then(function () { return send('Console.enable'); }).catch(function () {})
    .then(function () { return send('Log.enable'); }).catch(function () {})
    .then(function () { return send('Runtime.enable'); }).catch(function () {})
    .then(function () { return send('Page.enable'); })
    .then(function () {
      // Kurz warten, damit die Seite gerendert ist.
      return new Promise(function (r) { setTimeout(r, 1500); });
    })
    .then(function () {
      // Zusätzlich den sichtbaren Zustand abfragen – sagt mehr als ein Bild.
      return send('Runtime.evaluate', {
        expression: '(function(){' +
          'var cards=document.querySelectorAll(".card");' +
          'var r=cards.length?cards[0].getBoundingClientRect():null;' +
          'var r2=cards.length>1?cards[1].getBoundingClientRect():null;' +
          'return JSON.stringify({' +
          'cards:cards.length,' +
          'first:r?{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}:null,' +
          'second:r2?{x:Math.round(r2.left),y:Math.round(r2.top)}:null,' +
          'nebeneinander:(r&&r2)?(r2.left>r.left):null,' +
          'viewport:{w:innerWidth,h:innerHeight},' +
          'player:document.getElementById("player").className,' +
          'tabs:document.querySelectorAll("#tabs .tab").length' +
          '});})()',
        returnByValue: true,
      });
    })
    .then(function (res) {
      if (res && res.result && res.result.value) {
        console.log('Zustand:', res.result.value);
      }
      return send('Page.captureScreenshot', { format: 'png' });
    })
    .then(function (res) {
      fs.writeFileSync(outFile, Buffer.from(res.data, 'base64'));
      console.log('Screenshot gespeichert:', outFile);
      if (logs.length) {
        console.log('\nKonsole:');
        logs.slice(-20).forEach(function (l) { console.log('  ' + l); });
      } else {
        console.log('\nKonsole: keine Meldungen');
      }
      ws.close();
      process.exit(0);
    })
    .catch(function (e) {
      console.error('Fehler:', e.message);
      if (logs.length) { console.log('Konsole:'); logs.forEach(function (l) { console.log('  ' + l); }); }
      process.exit(1);
    });
});
