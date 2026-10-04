'use strict';
const $ = (id) => document.getElementById(id);
const say = (t) => { $('out').textContent = t; };

$('open').addEventListener('click', async () => {
  const r = await window.harness.open($('url').value.trim());
  say(r.ok ? `Opened ${r.label}` : `Refused: ${r.reason}`);
});
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('open').click(); });
$('chat').addEventListener('click', async () => say((await window.harness.chat()).message));
$('markbtn').addEventListener('click', async () => {
  await window.harness.mark($('mark').value);
  say('Marker written.');
  $('mark').select();
});
$('mark').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('markbtn').click(); });
window.harness.info().then((i) => { $('info').textContent = `profile: ${i.profile} | log: ${i.log}`; });
