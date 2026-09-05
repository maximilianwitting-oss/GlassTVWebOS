/**
 * Fernbedienung simulieren und den Zustand zurücklesen.
 *
 * Ohne das ließe sich auf dem Fernseher nur „schauen, ob es hübsch aussieht" –
 * mit ihm lässt sich prüfen, ob ein Tastendruck wirklich das tut, was er soll
 * (Player öffnet, Fokus wandert, Ansicht wechselt).
 *
 *   node tools/tvpoke.js <ws-url> <befehl> [...]
 *
 * Befehle:
 *   key <keyCode>          Taste senden (13=OK, 37/38/39/40=Pfeile, 461=Zurück)
 *   click <css-selektor>   Element anklicken
 *   eval <ausdruck>        beliebigen Ausdruck auswerten
 *   state                  Kurzbericht über die Oberfläche
 *   shot <datei.png>       Screenshot
 *   wait <ms>              warten
 */
'use strict';

var fs = require('fs');

var wsUrl = process.argv[2];
var script = process.argv.slice(3);
if (!wsUrl || !script.length) {
  console.error('Aufruf: node tools/tvpoke.js <ws-url> <befehl> [...]');
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

function evaluate(expression) {
  return send('Runtime.evaluate', { expression: expression, returnByValue: true })
    .then(function (r) { return r.result ? r.result.value : null; });
}

function key(code) {
  // Chromium 53 hört auf keyCode – die App wertet genau den aus.
  return evaluate(
    '(function(){var e=document.createEvent("Event");e.initEvent("keydown",true,true);' +
    'e.keyCode=' + code + ';e.which=' + code + ';document.dispatchEvent(e);return "ok";})()'
  );
}

var STATE_EXPR = '(function(){' +
  'var cards=document.querySelectorAll(".card");' +
  'var a=document.activeElement;' +
  'var v=document.getElementById("video");' +
  'return JSON.stringify({' +
  'tab:(function(){var t=document.querySelector("#tabs .tab.active");return t?t.textContent:null})(),' +
  'cards:cards.length,' +
  'rows:document.querySelectorAll(".channel").length,' +
  'chips:document.querySelectorAll(".chip").length,' +
  'fokus:a?(a.className+" | "+(a.textContent||"").slice(0,40)):null,' +
  'player:document.getElementById("player").className,' +
  'playerTitel:document.getElementById("player-title").textContent,' +
  'videoSrc:v.currentSrc||v.src||null,' +
  'videoFehler:v.error?v.error.code:null,' +
  'toast:document.getElementById("toast").textContent' +
  '});})()';

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
  if (msg.method === 'Runtime.exceptionThrown') {
    var d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception && d.exception.description || d.text));
  } else if (msg.method === 'Console.messageAdded') {
    logs.push('[' + msg.params.message.level + '] ' + msg.params.message.text);
  }
});

ws.addEventListener('error', function (e) {
  console.error('WebSocket-Fehler:', e.message || e);
  process.exit(1);
});

ws.addEventListener('open', function () {
  var chain = Promise.resolve()
    .then(function () { return send('Runtime.enable'); })
    .then(function () { return send('Console.enable'); }).catch(function () {})
    .then(function () { return send('Page.enable'); });

  var i = 0;
  while (i < script.length) {
    (function (cmd, arg) {
      chain = chain.then(function () {
        if (cmd === 'key') {
          return key(arg).then(function () { console.log('Taste ' + arg + ' gesendet'); });
        }
        if (cmd === 'click') {
          return evaluate('(function(){var n=document.querySelector(' + JSON.stringify(arg) + ');' +
            'if(!n)return "nicht gefunden: ' + arg + '";n.focus();n.click();return "geklickt";})()')
            .then(function (r) { console.log('click ' + arg + ': ' + r); });
        }
        if (cmd === 'eval') {
          return evaluate(arg).then(function (r) { console.log('eval: ' + JSON.stringify(r)); });
        }
        if (cmd === 'state') {
          return evaluate(STATE_EXPR).then(function (r) { console.log('Zustand: ' + r); });
        }
        if (cmd === 'wait') {
          return new Promise(function (res) { setTimeout(res, parseInt(arg, 10) || 500); });
        }
        if (cmd === 'shot') {
          return send('Page.captureScreenshot', { format: 'png' }).then(function (res) {
            fs.writeFileSync(arg, Buffer.from(res.data, 'base64'));
            console.log('Screenshot: ' + arg);
          });
        }
        return Promise.resolve();
      });
    })(script[i], script[i + 1]);
    // Befehle ohne Argument nicht zwei Schritte weiterspringen lassen.
    i += (script[i] === 'state') ? 1 : 2;
  }

  chain.then(function () {
    if (logs.length) { console.log('\nKonsole:'); logs.slice(-15).forEach(function (l) { console.log('  ' + l); }); }
    ws.close();
    process.exit(0);
  }).catch(function (e) {
    console.error('Fehler:', e.message);
    if (logs.length) { console.log('Konsole:'); logs.forEach(function (l) { console.log('  ' + l); }); }
    process.exit(1);
  });
});
