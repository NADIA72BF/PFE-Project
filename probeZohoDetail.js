const fetch = require('node-fetch');
const token = '1000.a73f68ca66bc3baecca47a99f36f0cba.7f9de4d1e13f227f45d4038ef9b478c2';
const id = '4899073000000090300';
const paths = [
  'form/Property/record/' + id,
  'form/Property/' + id,
  'form/Property/records/' + id,
  'form/Property/records?' + id,
  'form/Property/'+id+'?raw=true',
  'report/all_prop/record/' + id,
  'report/all_prop/' + id,
  'report/all_prop/records/' + id,
  'form/Property/' + id + '/record',
  'form/Property/' + id + '/raw',
  'form/Property/' + id + '/details'
];
(async () => {
  for (const p of paths) {
    const url = `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/${p}`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      const text = await res.text();
      console.log('URL:', url);
      console.log('STATUS:', res.status, res.statusText);
      console.log(text.slice(0, 400));
    } catch (err) {
      console.error('ERROR:', url, err.message);
    }
    console.log('-----');
  }
})();
